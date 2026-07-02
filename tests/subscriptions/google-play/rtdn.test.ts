import express, { json } from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { googlePlayWebhookRouter } from "@/api/v2/subscriptions/google-play-webhook.router";
import { pinoMiddleware } from "@/middleware/pino";
import { PlayNotificationType } from "@/subscriptions/google-play/notification-mapping";
import {
  resetPlayApiClientForTests,
  setPlayApiFixtureForTests,
  type SubscriptionPurchaseV2,
} from "@/subscriptions/google-play/play-api";
import { PlaySubscriptionState } from "@/subscriptions/google-play/status";
import {
  PubsubAuthError,
  setPubsubVerifierForTests,
} from "@/subscriptions/google-play/verifier";
import { BillingProvider, upsertFromVerify } from "@/subscriptions/repository";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const makeApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.use("/v2/webhooks/google-play", googlePlayWebhookRouter);
  return app;
};

const createdAccountIds: string[] = [];
const newAccount = async () => {
  const account = await prisma.account.create({ data: {} });
  createdAccountIds.push(account.id);
  return account.id;
};

const wipe = async () => {
  if (createdAccountIds.length === 0) return;
  await prisma.billingReceipt.deleteMany({
    where: { subscription: { accountId: { in: createdAccountIds } } },
  });
  await prisma.subscription.deleteMany({
    where: { accountId: { in: createdAccountIds } },
  });
  // Single-ledger: verify/renewal now write sub_grant ledger rows (FK to
  // Account), so clear the wallet + ledger before deleting accounts.
  await prisma.creditLedger.deleteMany({
    where: { accountId: { in: createdAccountIds } },
  });
  await prisma.userCredits.deleteMany({
    where: { accountId: { in: createdAccountIds } },
  });
  await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  createdAccountIds.length = 0;
};

const purchase = (
  overrides: Partial<SubscriptionPurchaseV2>,
): SubscriptionPurchaseV2 => ({
  subscriptionState: PlaySubscriptionState.active,
  startTime: "2026-05-01T00:00:00.000Z",
  latestOrderId: "GPA.0000-0000-0000-0001",
  lineItems: [
    {
      productId: "app.convos.subs.builder.monthly",
      expiryTime: "2026-07-01T00:00:00.000Z",
      autoRenewingPlan: { autoRenewEnabled: true },
    },
  ],
  externalAccountIdentifiers: { obfuscatedExternalAccountId: "obf-xyz" },
  ...overrides,
});

const envelope = (
  notification: Record<string, unknown>,
  messageId = `msg-${Math.random().toString(36).slice(2)}`,
) => ({
  message: {
    messageId,
    publishTime: new Date().toISOString(),
    data: Buffer.from(JSON.stringify(notification)).toString("base64"),
  },
  subscription: "projects/x/subscriptions/y",
});

beforeAll(() => {
  process.env.LOCAL_TESTING = "1";
});

afterEach(async () => {
  await wipe();
  resetPlayApiClientForTests();
  setPlayApiFixtureForTests(null);
  setPubsubVerifierForTests(null);
});

describe("POST /v2/webhooks/google-play/rtdn", () => {
  test("rejects missing/bad bearer token with 401", async () => {
    setPubsubVerifierForTests(() => {
      throw new PubsubAuthError("bad auth");
    });
    const res = await request(makeApp())
      .post("/v2/webhooks/google-play/rtdn")
      .send(envelope({ testNotification: { version: "1.0" } }));
    expect(res.status).toBe(401);
  });

  test("test notification acks 200 without touching DB", async () => {
    setPubsubVerifierForTests(() => undefined);
    const subsBefore = await prisma.subscription.count();
    const receiptsBefore = await prisma.billingReceipt.count();
    const res = await request(makeApp())
      .post("/v2/webhooks/google-play/rtdn")
      .send(envelope({ testNotification: { version: "1.0" } }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, kind: "test" });
    expect(await prisma.subscription.count()).toBe(subsBefore);
    expect(await prisma.billingReceipt.count()).toBe(receiptsBefore);
  });

  test("malformed envelope → 400", async () => {
    setPubsubVerifierForTests(() => undefined);
    const res = await request(makeApp())
      .post("/v2/webhooks/google-play/rtdn")
      .send({ wrong: "shape" });
    expect(res.status).toBe(400);
  });

  test("malformed base64 RTDN payload → 400", async () => {
    setPubsubVerifierForTests(() => undefined);
    // Send a fully-valid Pub/Sub envelope so the 400 only comes from the
    // inner base64/JSON decode, not from envelope-shape validation (which
    // the previous test already covers).
    const res = await request(makeApp())
      .post("/v2/webhooks/google-play/rtdn")
      .send({
        message: {
          messageId: "msg-1",
          publishTime: new Date().toISOString(),
          data: Buffer.from("not-json").toString("base64"),
        },
        subscription: "projects/x/subscriptions/y",
      });
    expect(res.status).toBe(400);
  });

  test("SUBSCRIPTION_PURCHASED for unknown sub → 200 ack (cold-start, /verify will create)", async () => {
    setPubsubVerifierForTests(() => undefined);
    setPlayApiFixtureForTests(() => purchase({}));
    const res = await request(makeApp())
      .post("/v2/webhooks/google-play/rtdn")
      .send(
        envelope({
          subscriptionNotification: {
            notificationType: PlayNotificationType.purchased,
            purchaseToken: "ptok-cold-start",
          },
        }),
      );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, applied: false });
  });

  test("RENEWED on a known subscription updates currentPeriodEnd + records receipt", async () => {
    setPubsubVerifierForTests(() => undefined);
    const accountId = await newAccount();
    await upsertFromVerify({
      provider: BillingProvider.googlePlay,
      accountId,
      obfuscatedAccountId: "obf-xyz",
      productId: "app.convos.subs.builder.monthly",
      tier: "plus",
      period: "monthly",
      status: "active",
      purchaseToken: "ptok-renew",
      linkedPurchaseToken: null,
      playOrderId: "GPA.seed-order",
      startedAt: new Date("2026-05-01T00:00:00.000Z"),
      currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
      willRenew: true,
      isInTrial: false,
      signedPayload: "seed",
    });
    setPlayApiFixtureForTests(() =>
      purchase({
        lineItems: [
          {
            productId: "app.convos.subs.builder.monthly",
            expiryTime: "2026-08-01T00:00:00.000Z",
            autoRenewingPlan: { autoRenewEnabled: true },
          },
        ],
      }),
    );

    const messageId = "msg-renew-1";
    const res = await request(makeApp())
      .post("/v2/webhooks/google-play/rtdn")
      .send(
        envelope(
          {
            subscriptionNotification: {
              notificationType: PlayNotificationType.renewed,
              purchaseToken: "ptok-renew",
            },
          },
          messageId,
        ),
      );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, applied: true });

    const sub = await prisma.subscription.findFirst({
      where: { provider: BillingProvider.googlePlay, accountId },
    });
    expect(sub?.currentPeriodEnd.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );

    const receipt = await prisma.billingReceipt.findFirst({
      where: { externalNotificationId: messageId },
    });
    expect(receipt?.provider).toBe(BillingProvider.googlePlay);
    expect(receipt?.idempotencyKey).toBe(`play-rtdn:${messageId}`);
  });

  test("replay of same messageId → 200 with applied=false, no double state apply", async () => {
    setPubsubVerifierForTests(() => undefined);
    const accountId = await newAccount();
    await upsertFromVerify({
      provider: BillingProvider.googlePlay,
      accountId,
      obfuscatedAccountId: "obf-xyz",
      productId: "app.convos.subs.builder.monthly",
      tier: "plus",
      period: "monthly",
      status: "active",
      purchaseToken: "ptok-replay",
      linkedPurchaseToken: null,
      playOrderId: "GPA.seed-replay",
      startedAt: new Date("2026-05-01T00:00:00.000Z"),
      currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
      willRenew: true,
      isInTrial: false,
      signedPayload: "seed",
    });
    setPlayApiFixtureForTests(() => purchase({}));

    const env = envelope(
      {
        subscriptionNotification: {
          notificationType: PlayNotificationType.expired,
          purchaseToken: "ptok-replay",
        },
      },
      "msg-replay-1",
    );

    const first = await request(makeApp())
      .post("/v2/webhooks/google-play/rtdn")
      .send(env);
    expect(first.status).toBe(200);

    const second = await request(makeApp())
      .post("/v2/webhooks/google-play/rtdn")
      .send(env);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, applied: false });

    const receipts = await prisma.billingReceipt.findMany({
      where: { externalNotificationId: "msg-replay-1" },
    });
    expect(receipts).toHaveLength(1);
  });
});
