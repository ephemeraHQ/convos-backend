import { generateKeyPairSync } from "node:crypto";
import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import express, { json } from "express";
import { importPKCS8, SignJWT } from "jose";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { accountsMeRouter } from "@/api/v2/accounts/accountsMeRouter";
import { authMiddleware } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import {
  resetVerifierForTests,
  setVerifierForTests,
} from "@/subscriptions/jws-verifier";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const TEST_BUNDLE_ID = "app.convos.test";

const makeApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.use("/v2/accounts/me", authMiddleware, accountsMeRouter);
  return app;
};

const installLocalTestingVerifier = () => {
  const verifier = new SignedDataVerifier(
    [],
    false,
    Environment.LOCAL_TESTING,
    TEST_BUNDLE_ID,
    1234,
  );
  setVerifierForTests(verifier);
};

let signingPrivateKey: string;
const createdAccountIds: string[] = [];

const newAccount = async () => {
  const account = await prisma.account.create({ data: {} });
  createdAccountIds.push(account.id);
  return account.id;
};

const tokenFor = async (accountId: string) =>
  createJwtToken({ deviceId: `dev-${accountId.slice(0, 8)}`, accountId });

const wipe = async () => {
  if (createdAccountIds.length === 0) return;
  await prisma.appleReceipt.deleteMany({
    where: { subscription: { accountId: { in: createdAccountIds } } },
  });
  await prisma.subscription.deleteMany({
    where: { accountId: { in: createdAccountIds } },
  });
  await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  createdAccountIds.length = 0;
};

beforeAll(async () => {
  await validateJWTKeys();
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  signingPrivateKey = privateKey;
});

afterEach(async () => {
  await wipe();
  resetVerifierForTests();
});

type ErrorBody = { error?: string };
type VerifyBody = {
  subscription: {
    tier: string;
    period: string;
    status: string;
    productId: string;
    currentPeriodEnd: string;
    willRenew: boolean;
    isInTrial: boolean;
  };
};

const signTransaction = async (overrides: Record<string, unknown>) => {
  const payload = {
    transactionId: "2000000000000001",
    originalTransactionId: "2000000000000001",
    bundleId: TEST_BUNDLE_ID,
    productId: "app.convos.subs.builder.monthly",
    purchaseDate: new Date("2026-05-01T00:00:00.000Z").getTime(),
    originalPurchaseDate: new Date("2026-05-01T00:00:00.000Z").getTime(),
    expiresDate: new Date("2026-06-01T00:00:00.000Z").getTime(),
    type: "Auto-Renewable Subscription",
    appAccountToken: "11111111-2222-3333-4444-555555555555",
    inAppOwnershipType: "PURCHASED",
    signedDate: Date.now(),
    environment: "LocalTesting",
    ...overrides,
  };
  const privateKey = await importPKCS8(signingPrivateKey, "ES256");
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256" })
    .sign(privateKey);
};

describe("GET /v2/accounts/me/subscription", () => {
  test("returns 204 when caller has no subscription", async () => {
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/accounts/me/subscription")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(204);
  });

  test("returns 403 when JWT carries no accountId", async () => {
    const token = await createJwtToken({ deviceId: "dev-no-account" });
    const res = await request(makeApp())
      .get("/v2/accounts/me/subscription")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(403);
  });

  test("returns 200 with iOS UserSubscription shape after verify", async () => {
    installLocalTestingVerifier();
    const accountId = await newAccount();
    const token = await tokenFor(accountId);

    await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({
        jwsRepresentation: await signTransaction({
          appAccountToken: "11111111-2222-3333-4444-555555555555",
        }),
      });

    const res = await request(makeApp())
      .get("/v2/accounts/me/subscription")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tier: "builder",
      period: "monthly",
      status: "active",
      productId: "app.convos.subs.builder.monthly",
      currentPeriodEnd: "2026-06-01T00:00:00.000Z",
      willRenew: true,
      isInTrial: false,
    });
  });
});

describe("POST /v2/accounts/me/subscription/verify", () => {
  test("returns 403 when JWT carries no accountId", async () => {
    installLocalTestingVerifier();
    const token = await createJwtToken({ deviceId: "dev-no-account" });
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({ jwsRepresentation: await signTransaction({}) });
    expect(res.status).toBe(403);
  });

  test("returns 400 on missing jwsRepresentation", async () => {
    installLocalTestingVerifier();
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({});
    expect(res.status).toBe(400);
  });

  test("rejects extra body fields (appAccountToken must come from JWS, not body)", async () => {
    installLocalTestingVerifier();
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({
        jwsRepresentation: await signTransaction({}),
        appAccountToken: "11111111-2222-3333-4444-555555555555",
      });
    expect(res.status).toBe(400);
  });

  test("returns 400 when JWS fails to verify", async () => {
    installLocalTestingVerifier();
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({ jwsRepresentation: "garbage.not.jws" });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe("Invalid signed transaction");
  });

  test("returns 400 when JWS carries no appAccountToken", async () => {
    installLocalTestingVerifier();
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({
        jwsRepresentation: await signTransaction({
          appAccountToken: undefined,
        }),
      });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toMatch(/appAccountToken/);
  });

  test("returns 400 on unknown productId", async () => {
    installLocalTestingVerifier();
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({
        jwsRepresentation: await signTransaction({
          productId: "app.bogus.sku",
        }),
      });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toMatch(/Unrecognized productId/);
  });

  test("happy path: creates subscription, returns iOS UserSubscription shape", async () => {
    installLocalTestingVerifier();
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({
        jwsRepresentation: await signTransaction({
          productId: "app.convos.subs.pro.annual",
          appAccountToken: "11111111-2222-3333-4444-555555555555",
        }),
      });
    expect(res.status).toBe(200);
    const body = res.body as VerifyBody;
    expect(body.subscription).toEqual({
      tier: "pro",
      period: "annual",
      status: "active",
      productId: "app.convos.subs.pro.annual",
      currentPeriodEnd: "2026-06-01T00:00:00.000Z",
      willRenew: true,
      isInTrial: false,
    });

    const persisted = await prisma.subscription.findUnique({
      where: { originalTransactionId: "2000000000000001" },
    });
    expect(persisted?.accountId).toBe(accountId);
    expect(persisted?.appAccountToken).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(persisted?.tier).toBe("pro");
  });

  test("introductory offer → status=trial, isInTrial=true", async () => {
    installLocalTestingVerifier();
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({
        jwsRepresentation: await signTransaction({
          appAccountToken: "11111111-2222-3333-4444-555555555555",
          offerType: 1, // INTRODUCTORY_OFFER
        }),
      });
    expect(res.status).toBe(200);
    const body = res.body as VerifyBody;
    expect(body.subscription.status).toBe("trial");
    expect(body.subscription.isInTrial).toBe(true);
  });

  test("expired transaction JWS persists as expired, not active/trial", async () => {
    installLocalTestingVerifier();
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({
        jwsRepresentation: await signTransaction({
          appAccountToken: "11111111-2222-3333-4444-555555555555",
          expiresDate: Date.now() - 60_000,
          offerType: 1, // INTRODUCTORY_OFFER would be trial if not expired
        }),
      });
    expect(res.status).toBe(200);
    const body = res.body as VerifyBody;
    expect(body.subscription.status).toBe("expired");
    expect(body.subscription.isInTrial).toBe(false);
  });

  test("replay of same transactionId is idempotent (single AppleReceipt)", async () => {
    installLocalTestingVerifier();
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const body = {
      jwsRepresentation: await signTransaction({
        appAccountToken: "11111111-2222-3333-4444-555555555555",
      }),
    };

    await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send(body);
    const res2 = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send(body);

    expect(res2.status).toBe(200);
    const receipts = await prisma.appleReceipt.findMany({
      where: { transactionId: "2000000000000001" },
    });
    expect(receipts).toHaveLength(1);
  });

  test("cross-account re-verify rejected with 409 (subscription belongs to original buyer)", async () => {
    installLocalTestingVerifier();
    const accountA = await newAccount();
    const accountB = await newAccount();
    const tokenA = await tokenFor(accountA);
    const tokenB = await tokenFor(accountB);

    const firstRes = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", tokenA)
      .send({
        jwsRepresentation: await signTransaction({
          appAccountToken: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        }),
      });
    expect(firstRes.status).toBe(200);

    // Account B tries to claim the same Apple subscription. Even though Apple
    // signed the JWS, our strict ownership check rejects: the original buyer
    // (account A) owns it for life. Transfer is a support operation.
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", tokenB)
      .send({
        jwsRepresentation: await signTransaction({
          appAccountToken: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          transactionId: "2000000000000002",
        }),
      });
    expect(res.status).toBe(409);
    const body = res.body as ErrorBody & { code?: string };
    expect(body.code).toBe("subscription_account_mismatch");

    // Persisted sub stays bound to accountA.
    const persisted = await prisma.subscription.findUnique({
      where: { originalTransactionId: "2000000000000001" },
    });
    expect(persisted?.accountId).toBe(accountA);
  });
});
