import { generateKeyPairSync } from "node:crypto";
import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import { BillingProvider } from "@prisma/client";
import express, { json } from "express";
import { importPKCS8, SignJWT } from "jose";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { accountsMeRouter } from "@/api/v2/accounts/accountsMeRouter";
import { authMiddleware } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { evaluateClaimable } from "@/subscriptions/claim-eligibility";
import {
  resetVerifierForTests,
  setVerifierForTests,
} from "@/subscriptions/jws-verifier";
import {
  applyNotification,
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionPeriod,
  SubscriptionStatus,
  upsertFromVerify,
  type AppleVerifyInput,
  type GooglePlayVerifyInput,
} from "@/subscriptions/repository";
import { SubscriptionTombstonedError } from "@/subscriptions/tombstones";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const TEST_BUNDLE_ID = "app.convos.test";
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_START = new Date("2026-06-01T00:00:00.000Z");
const PERIOD_END = new Date(Date.now() + 30 * DAY_MS);

const createdAccountIds: string[] = [];

const newAccount = async () => {
  const account = await prisma.account.create({ data: {} });
  createdAccountIds.push(account.id);
  return account.id;
};

const wipe = async () => {
  delete process.env.SUBSCRIPTION_CLAIM_TOMBSTONE_ENABLED;
  await prisma.subscriptionTransfer.deleteMany();
  await prisma.lineagePeriodCustody.deleteMany();
  await prisma.lineagePeriodGrant.deleteMany();
  await prisma.lineageTokenAlias.deleteMany();
  await prisma.subscriptionLineage.deleteMany();
  if (createdAccountIds.length === 0) return;
  await prisma.billingReceipt.deleteMany({
    where: { subscription: { accountId: { in: createdAccountIds } } },
  });
  await prisma.subscription.deleteMany({
    where: { accountId: { in: createdAccountIds } },
  });
  await prisma.creditLedger.deleteMany({
    where: { accountId: { in: createdAccountIds } },
  });
  await prisma.userCredits.deleteMany({
    where: { accountId: { in: createdAccountIds } },
  });
  await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  createdAccountIds.length = 0;
};

const appleInput = (
  accountId: string,
  otx: string,
  overrides: Partial<AppleVerifyInput> = {},
): AppleVerifyInput => ({
  provider: BillingProvider.apple,
  accountId,
  appAccountToken: "11111111-2222-3333-4444-555555555555",
  productId: "app.convos.subs.monthly",
  tier: SUBSCRIPTION_TIER_PLUS,
  period: SubscriptionPeriod.monthly,
  status: SubscriptionStatus.active,
  originalTransactionId: otx,
  transactionId: `tx-${otx}`,
  startedAt: PERIOD_START,
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  willRenew: true,
  isInTrial: false,
  environment: "sandbox",
  signedPayload: "jws-test-payload",
  ...overrides,
});

const playInput = (
  accountId: string,
  purchaseToken: string,
  overrides: Partial<GooglePlayVerifyInput> = {},
): GooglePlayVerifyInput => ({
  provider: BillingProvider.googlePlay,
  accountId,
  obfuscatedAccountId: `oid-${purchaseToken}`,
  productId: "app.convos.subs.monthly",
  tier: SUBSCRIPTION_TIER_PLUS,
  period: SubscriptionPeriod.monthly,
  status: SubscriptionStatus.active,
  purchaseToken,
  linkedPurchaseToken: null,
  playOrderId: `order-${purchaseToken}`,
  startedAt: PERIOD_START,
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  willRenew: true,
  isInTrial: false,
  signedPayload: "{}",
  ...overrides,
});

const tombstone = (provider: BillingProvider, providerKey: string) =>
  prisma.subscriptionLineage.create({
    data: {
      provider,
      lineageKey: providerKey,
      state: "tombstoned",
      tombstonedAt: new Date(),
      deletedAccountRef: "ref-test",
    },
  });

afterEach(wipe);

describe("verify against deletion tombstones", () => {
  test("tombstoned Apple key with no live row: throws, creates nothing", async () => {
    const accountId = await newAccount();
    await tombstone(BillingProvider.apple, "otx-dead");

    await expect(
      upsertFromVerify(appleInput(accountId, "otx-dead")),
    ).rejects.toBeInstanceOf(SubscriptionTombstonedError);

    expect(await prisma.subscription.count()).toBe(0);
    expect(await prisma.billingReceipt.count()).toBe(0);
    expect(await prisma.creditLedger.count({ where: { accountId } })).toBe(0);
  });

  test("a live row for the key wins over a tombstone (post-claim state)", async () => {
    const accountId = await newAccount();
    await upsertFromVerify(appleInput(accountId, "otx-claimed"));
    // Flip the verify-created lineage to tombstoned while the row lives.
    await prisma.subscriptionLineage.updateMany({
      where: { provider: BillingProvider.apple, lineageKey: "otx-claimed" },
      data: { state: "tombstoned", tombstonedAt: new Date() },
    });

    const result = await upsertFromVerify(appleInput(accountId, "otx-claimed"));
    expect(result.subscription.accountId).toBe(accountId);
  });

  test("Play verify ingest resolves a rotated token through recursive aliases", async () => {
    const accountId = await newAccount();
    await tombstone(BillingProvider.googlePlay, "token-old");

    await expect(
      upsertFromVerify(
        playInput(accountId, "token-new", {
          linkedPurchaseToken: "token-old",
        }),
      ),
    ).rejects.toBeInstanceOf(SubscriptionTombstonedError);

    // Recursive ingest aliases the new token to the predecessor's lineage.
    const absorbed = await prisma.lineageTokenAlias.findUnique({
      where: { token: "token-new" },
    });
    expect(absorbed).not.toBeNull();
    const lineage = await prisma.subscriptionLineage.findUnique({
      where: { id: absorbed?.lineageId ?? "" },
    });
    expect(lineage?.state).toBe("tombstoned");
  });
});

describe("webhooks against deletion tombstones", () => {
  test("Apple notification for a tombstoned key: counted no-op", async () => {
    await tombstone(BillingProvider.apple, "otx-dead");
    const result = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: "otx-dead",
      transactionId: "tx-1",
      notificationUUID: "uuid-1",
      notificationType: "DID_RENEW",
      signedPayload: "jws",
      update: { status: SubscriptionStatus.active },
    });
    expect(result).toEqual({ kind: "tombstoned" });
    expect(await prisma.billingReceipt.count()).toBe(0);
  });

  test("Play RTDN rotation onto a tombstoned token: counted no-op", async () => {
    await tombstone(BillingProvider.googlePlay, "token-old");
    const result = await applyNotification({
      provider: BillingProvider.googlePlay,
      purchaseToken: "token-new",
      linkedPurchaseToken: "token-old",
      playOrderId: "order-1",
      messageId: "msg-1",
      notificationType: "PLAY_2",
      signedPayload: "{}",
      update: { status: SubscriptionStatus.active },
    });
    expect(result).toEqual({ kind: "tombstoned" });
  });

  test("unknown key with no tombstone stays unknown_subscription", async () => {
    const result = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: "otx-never-seen",
      transactionId: "tx-1",
      notificationUUID: "uuid-2",
      notificationType: "DID_RENEW",
      signedPayload: "jws",
      update: { status: SubscriptionStatus.active },
    });
    expect(result).toEqual({ kind: "unknown_subscription" });
  });
});

describe("claimable evaluation", () => {
  test("true for a tombstoned lineage, false otherwise", async () => {
    await tombstone(BillingProvider.apple, "otx-dead");
    expect(
      await evaluateClaimable({
        provider: BillingProvider.apple,
        keys: ["otx-dead"],
      }),
    ).toBe(true);
    expect(
      await evaluateClaimable({
        provider: BillingProvider.apple,
        keys: ["otx-live"],
      }),
    ).toBe(false);
  });
});

describe("verify handler 409 shapes", () => {
  let signingPrivateKey: string;

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

  const signTransaction = async (overrides: Record<string, unknown>) => {
    const payload = {
      transactionId: "3000000000000001",
      originalTransactionId: "3000000000000001",
      bundleId: TEST_BUNDLE_ID,
      productId: "app.convos.subs.monthly",
      purchaseDate: PERIOD_START.getTime(),
      originalPurchaseDate: PERIOD_START.getTime(),
      expiresDate: PERIOD_END.getTime(),
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

  beforeAll(async () => {
    await validateJWTKeys();
    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    signingPrivateKey = privateKey;
  });

  afterEach(() => {
    resetVerifierForTests();
  });

  const tokenFor = (accountId: string) =>
    createJwtToken({ deviceId: `dev-${accountId.slice(0, 8)}`, accountId });

  test("tombstoned key: 409 subscription_account_mismatch with claimable true", async () => {
    installLocalTestingVerifier();
    const accountId = await newAccount();
    await tombstone(BillingProvider.apple, "3000000000000001");

    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", await tokenFor(accountId))
      .send({
        platform: "apple",
        jwsRepresentation: await signTransaction({}),
      });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Subscription belongs to a different account. Contact support.",
      code: "subscription_account_mismatch",
      claimable: true,
    });
    expect(await prisma.subscription.count()).toBe(0);
  });

  test("tombstoned key does not advertise a disabled claim path", async () => {
    process.env.SUBSCRIPTION_CLAIM_TOMBSTONE_ENABLED = "false";
    installLocalTestingVerifier();
    const accountId = await newAccount();
    await tombstone(BillingProvider.apple, "3000000000000001");

    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", await tokenFor(accountId))
      .send({
        platform: "apple",
        jwsRepresentation: await signTransaction({}),
      });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Subscription belongs to a different account. Contact support.",
      code: "subscription_account_mismatch",
      claimable: false,
    });
  });

  test("owner mismatch on a live row: 409 with claimable false", async () => {
    installLocalTestingVerifier();
    const owner = await newAccount();
    const intruder = await newAccount();
    await upsertFromVerify(appleInput(owner, "3000000000000001"));

    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", await tokenFor(intruder))
      .send({
        platform: "apple",
        jwsRepresentation: await signTransaction({}),
      });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Subscription belongs to a different account. Contact support.",
      code: "subscription_account_mismatch",
      claimable: false,
    });
  });
});
