import { generateKeyPairSync } from "node:crypto";
import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import express, { json } from "express";
import { importPKCS8, SignJWT } from "jose";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { appleWebhookRouter } from "@/api/v2/subscriptions/apple-webhook.router";
import { pinoMiddleware } from "@/middleware/pino";
import {
  resetVerifierForTests,
  setVerifierForTests,
} from "@/subscriptions/jws-verifier";
import {
  AppleEnv,
  SubscriptionPeriod,
  SubscriptionStatus,
  SubscriptionTier,
  upsertFromVerify,
} from "@/subscriptions/repository";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const TEST_BUNDLE_ID = "app.convos.test";

const makeApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.use("/v2/webhooks/apple", appleWebhookRouter);
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

beforeAll(() => {
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

const sign = async (payload: object) => {
  const privateKey = await importPKCS8(signingPrivateKey, "ES256");
  return new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: "ES256" })
    .sign(privateKey);
};

const signTransaction = (overrides: Record<string, unknown>) =>
  sign({
    transactionId: "3000000000000001",
    originalTransactionId: "1000000000000001",
    bundleId: TEST_BUNDLE_ID,
    productId: "app.convos.subs.builder.monthly",
    purchaseDate: new Date("2026-06-01T00:00:00.000Z").getTime(),
    originalPurchaseDate: new Date("2026-05-01T00:00:00.000Z").getTime(),
    expiresDate: new Date("2026-07-01T00:00:00.000Z").getTime(),
    type: "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED",
    signedDate: Date.now(),
    environment: "LocalTesting",
    ...overrides,
  });

const signNotification = async (args: {
  notificationType: string;
  subtype?: string;
  signedTransactionInfo: string;
  notificationUUID?: string;
}) =>
  sign({
    notificationType: args.notificationType,
    subtype: args.subtype,
    notificationUUID:
      args.notificationUUID ?? "12345678-1234-1234-1234-123456789012",
    version: "2.0",
    signedDate: Date.now(),
    data: {
      environment: "LocalTesting",
      bundleId: TEST_BUNDLE_ID,
      signedTransactionInfo: args.signedTransactionInfo,
      signedRenewalInfo: "stub.renewal.info",
      status: 1,
    },
  });

const seedSubscription = async (
  originalTransactionId: string,
  overrides: { tier?: SubscriptionTier; transactionId?: string } = {},
) => {
  const accountId = await newAccount();
  const { subscription } = await upsertFromVerify({
    accountId,
    appAccountToken: "00000000-0000-0000-0000-000000000001",
    productId: "app.convos.subs.builder.monthly",
    tier: overrides.tier ?? SubscriptionTier.builder,
    period: SubscriptionPeriod.monthly,
    status: SubscriptionStatus.active,
    originalTransactionId,
    transactionId: overrides.transactionId ?? "seed-tx",
    startedAt: new Date("2026-05-01T00:00:00.000Z"),
    currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
    willRenew: true,
    isInTrial: false,
    environment: AppleEnv.sandbox,
    signedPayload: "stub.seed.jws",
  });
  return { accountId, subscription };
};

type AckBody = { ok: boolean; applied?: boolean; skipped?: string };

describe("POST /v2/webhooks/apple/ssn", () => {
  test("rejects an invalid body shape", async () => {
    installLocalTestingVerifier();
    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({});
    expect(res.status).toBe(400);
  });

  test("rejects a malformed JWS notification", async () => {
    installLocalTestingVerifier();
    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload: "not.a.jws" });
    expect(res.status).toBe(400);
  });

  test("acks 200 with skipped=no_transaction for notifications without a transaction", async () => {
    installLocalTestingVerifier();
    // Build a notification without data.signedTransactionInfo.
    const signedPayload = await sign({
      notificationType: "TEST",
      notificationUUID: "11111111-2222-3333-4444-555555555555",
      version: "2.0",
      signedDate: Date.now(),
      data: {
        environment: "LocalTesting",
        bundleId: TEST_BUNDLE_ID,
        signedTransactionInfo: "",
        status: 1,
      },
    });
    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload });
    expect(res.status).toBe(200);
    expect((res.body as AckBody).skipped).toBe("no_transaction");
  });

  test("DID_RENEW: extends currentPeriodEnd + audit row written", async () => {
    installLocalTestingVerifier();
    const otid = "1000000000000010";
    const { subscription } = await seedSubscription(otid);

    const transactionJws = await signTransaction({
      originalTransactionId: otid,
      transactionId: "3000000000000010",
      productId: "app.convos.subs.builder.monthly",
      purchaseDate: new Date("2026-06-01T00:00:00.000Z").getTime(),
      expiresDate: new Date("2026-07-01T00:00:00.000Z").getTime(),
    });
    const signedPayload = await signNotification({
      notificationType: "DID_RENEW",
      signedTransactionInfo: transactionJws,
    });

    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload });
    expect(res.status).toBe(200);
    expect((res.body as AckBody).applied).toBe(true);

    const updated = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(updated?.currentPeriodEnd.toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(updated?.status).toBe(SubscriptionStatus.active);

    const receipts = await prisma.appleReceipt.findMany({
      where: { subscriptionId: subscription.id },
      orderBy: [{ receivedAt: "asc" }, { transactionId: "asc" }],
    });
    expect(receipts).toHaveLength(2); // seed + DID_RENEW
    expect(receipts[1].notificationType).toBe("DID_RENEW");
  });

  test("DID_FAIL_TO_RENEW + GRACE_PERIOD: status → grace, sets gracePeriodEnd", async () => {
    installLocalTestingVerifier();
    const otid = "1000000000000020";
    const { subscription } = await seedSubscription(otid);

    const transactionJws = await signTransaction({
      originalTransactionId: otid,
      transactionId: "3000000000000020",
      expiresDate: new Date("2026-06-15T00:00:00.000Z").getTime(),
    });
    const signedPayload = await signNotification({
      notificationType: "DID_FAIL_TO_RENEW",
      subtype: "GRACE_PERIOD",
      signedTransactionInfo: transactionJws,
    });

    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload });
    expect(res.status).toBe(200);
    expect((res.body as AckBody).applied).toBe(true);

    const updated = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(updated?.status).toBe(SubscriptionStatus.grace);
    expect(updated?.gracePeriodEnd?.toISOString()).toBe(
      "2026-06-15T00:00:00.000Z",
    );
  });

  test("DID_FAIL_TO_RENEW + BILLING_RETRY: status → billingRetry", async () => {
    installLocalTestingVerifier();
    const otid = "1000000000000030";
    const { subscription } = await seedSubscription(otid);

    const signedPayload = await signNotification({
      notificationType: "DID_FAIL_TO_RENEW",
      subtype: "BILLING_RETRY",
      signedTransactionInfo: await signTransaction({
        originalTransactionId: otid,
        transactionId: "3000000000000030",
      }),
    });

    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload });
    expect(res.status).toBe(200);
    expect((res.body as AckBody).applied).toBe(true);

    const updated = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(updated?.status).toBe(SubscriptionStatus.billingRetry);
  });

  test("EXPIRED: status → expired, willRenew → false", async () => {
    installLocalTestingVerifier();
    const otid = "1000000000000040";
    const { subscription } = await seedSubscription(otid);

    const signedPayload = await signNotification({
      notificationType: "EXPIRED",
      signedTransactionInfo: await signTransaction({
        originalTransactionId: otid,
        transactionId: "3000000000000040",
      }),
    });

    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload });
    expect(res.status).toBe(200);
    expect((res.body as AckBody).applied).toBe(true);

    const updated = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(updated?.status).toBe(SubscriptionStatus.expired);
    expect(updated?.willRenew).toBe(false);
  });

  test("REVOKE: status → revoked, cancelledAt set, willRenew → false", async () => {
    installLocalTestingVerifier();
    const otid = "1000000000000050";
    const { subscription } = await seedSubscription(otid);

    const signedPayload = await signNotification({
      notificationType: "REVOKE",
      signedTransactionInfo: await signTransaction({
        originalTransactionId: otid,
        transactionId: "3000000000000050",
      }),
    });

    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload });
    expect(res.status).toBe(200);
    expect((res.body as AckBody).applied).toBe(true);

    const updated = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(updated?.status).toBe(SubscriptionStatus.revoked);
    expect(updated?.willRenew).toBe(false);
    expect(updated?.cancelledAt).not.toBeNull();
  });

  test("DID_CHANGE_RENEWAL_STATUS + AUTO_RENEW_DISABLED: willRenew → false", async () => {
    installLocalTestingVerifier();
    const otid = "1000000000000060";
    const { subscription } = await seedSubscription(otid);

    const signedPayload = await signNotification({
      notificationType: "DID_CHANGE_RENEWAL_STATUS",
      subtype: "AUTO_RENEW_DISABLED",
      signedTransactionInfo: await signTransaction({
        originalTransactionId: otid,
        transactionId: "3000000000000060",
      }),
    });

    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload });
    expect(res.status).toBe(200);
    expect((res.body as AckBody).applied).toBe(true);

    const updated = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(updated?.willRenew).toBe(false);
    expect(updated?.status).toBe(SubscriptionStatus.active); // unchanged
  });

  test("DID_CHANGE_RENEWAL_PREF: tier upgrade Builder → Pro", async () => {
    installLocalTestingVerifier();
    const otid = "1000000000000070";
    const { subscription } = await seedSubscription(otid);

    const signedPayload = await signNotification({
      notificationType: "DID_CHANGE_RENEWAL_PREF",
      subtype: "UPGRADE",
      signedTransactionInfo: await signTransaction({
        originalTransactionId: otid,
        transactionId: "3000000000000070",
        productId: "app.convos.subs.pro.monthly",
      }),
    });

    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload });
    expect(res.status).toBe(200);
    expect((res.body as AckBody).applied).toBe(true);

    const updated = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(updated?.tier).toBe(SubscriptionTier.pro);
    expect(updated?.productId).toBe("app.convos.subs.pro.monthly");
  });

  test("unrecognized productId on DID_RENEW: acks 200, no crash, status still updates", async () => {
    installLocalTestingVerifier();
    const otid = "1000000000000075";
    const { subscription: original } = await seedSubscription(otid);

    const signedPayload = await signNotification({
      notificationType: "DID_RENEW",
      signedTransactionInfo: await signTransaction({
        originalTransactionId: otid,
        transactionId: "3000000000000075",
        productId: "app.convos.subs.unknown.future",
        expiresDate: new Date("2026-08-01T00:00:00.000Z").getTime(),
      }),
    });

    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload });
    // Critical: must NOT 500 on unknown SKU — Apple would retry indefinitely.
    expect(res.status).toBe(200);
    expect((res.body as AckBody).applied).toBe(true);

    const after = await prisma.subscription.findUnique({
      where: { id: original.id },
    });
    // Tier/productId unchanged (unknown SKU not mapped),
    // but status + period window did update.
    expect(after?.tier).toBe(original.tier);
    expect(after?.productId).toBe(original.productId);
    expect(after?.currentPeriodEnd.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  });

  test("DID_CHANGE_RENEWAL_PREF without productId: acks 200, no Subscription update", async () => {
    installLocalTestingVerifier();
    const otid = "1000000000000071";
    const { subscription: original } = await seedSubscription(otid);

    const signedPayload = await signNotification({
      notificationType: "DID_CHANGE_RENEWAL_PREF",
      subtype: "UPGRADE",
      signedTransactionInfo: await signTransaction({
        originalTransactionId: otid,
        transactionId: "3000000000000071",
        productId: undefined,
      }),
    });

    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload });
    expect(res.status).toBe(200);
    expect((res.body as AckBody).applied).toBe(false);

    const after = await prisma.subscription.findUnique({
      where: { id: original.id },
    });
    expect(after?.tier).toBe(original.tier);
    expect(after?.productId).toBe(original.productId);
    expect(after?.updatedAt.toISOString()).toBe(
      original.updatedAt.toISOString(),
    );
  });

  test("unknown subscription: acks 200, no row created", async () => {
    installLocalTestingVerifier();
    const signedPayload = await signNotification({
      notificationType: "DID_RENEW",
      signedTransactionInfo: await signTransaction({
        originalTransactionId: "9999999999999999",
        transactionId: "3000000000000080",
      }),
    });

    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload });
    expect(res.status).toBe(200);
    expect((res.body as AckBody).applied).toBe(false);

    const rows = await prisma.subscription.findMany({
      where: { originalTransactionId: "9999999999999999" },
    });
    expect(rows).toHaveLength(0);
  });

  test("replay (same notificationUUID) does not re-apply state — second flip is ignored", async () => {
    installLocalTestingVerifier();
    const otid = "1000000000000090";
    const { subscription } = await seedSubscription(otid);

    const renewPayload = await signNotification({
      notificationType: "DID_RENEW",
      signedTransactionInfo: await signTransaction({
        originalTransactionId: otid,
        transactionId: "3000000000000090",
      }),
    });

    await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload: renewPayload });

    // Replay the same notification.
    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload: renewPayload });
    expect(res.status).toBe(200);
    expect((res.body as AckBody).applied).toBe(false);

    const receipts = await prisma.appleReceipt.findMany({
      where: {
        subscriptionId: subscription.id,
        transactionId: "3000000000000090",
      },
    });
    expect(receipts).toHaveLength(1);
  });

  test("TEST notification with transaction: actionless → 200 + applied:false", async () => {
    installLocalTestingVerifier();
    const otid = "1000000000000100";
    await seedSubscription(otid);

    const signedPayload = await signNotification({
      notificationType: "TEST",
      signedTransactionInfo: await signTransaction({
        originalTransactionId: otid,
        transactionId: "3000000000000100",
      }),
    });

    const res = await request(makeApp())
      .post("/v2/webhooks/apple/ssn")
      .send({ signedPayload });
    expect(res.status).toBe(200);
    expect((res.body as AckBody).applied).toBe(false);

    // No AppleReceipt should have been written (we skipped before applyNotification).
    const receipts = await prisma.appleReceipt.findMany({
      where: { transactionId: "3000000000000100" },
    });
    expect(receipts).toHaveLength(0);
  });
});
