import { LedgerReason } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { accountsMeRouter } from "@/api/v2/accounts/accountsMeRouter";
import { authMiddleware } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { getSpendableBalance } from "@/payments/spendable";
import {
  AppleEnv,
  BillingProvider,
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionPeriod,
  SubscriptionStatus,
  upsertFromVerify,
} from "@/subscriptions/repository";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const DAY_MS = 24 * 60 * 60 * 1000;
const flooredToSecond = (ms: number): Date => {
  const d = new Date(ms);
  d.setUTCMilliseconds(0);
  return d;
};
const NOW_MS = Date.now();
const PERIOD_START = flooredToSecond(NOW_MS - 5 * DAY_MS);
const PERIOD_END = flooredToSecond(NOW_MS + 25 * DAY_MS);
const PLUS_ANNUAL_END = flooredToSecond(NOW_MS + 395 * DAY_MS);
const WITHIN_PERIOD_A = flooredToSecond(NOW_MS - 1 * DAY_MS);
const WITHIN_PERIOD_B = flooredToSecond(NOW_MS - 2 * DAY_MS);
const BEFORE_PERIOD = flooredToSecond(NOW_MS - 10 * DAY_MS);
const PERIOD_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
}).format(PERIOD_START);

const makeApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(express.json());
  app.use("/v2/accounts/me", authMiddleware, accountsMeRouter);
  return app;
};

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

beforeAll(async () => {
  await validateJWTKeys();
});

afterEach(async () => {
  await wipe();
});

const seedPlusMonthly = async (accountId: string) =>
  upsertFromVerify({
    provider: BillingProvider.apple,
    accountId,
    appAccountToken: `${accountId.slice(0, 8)}-2222-3333-4444-555555555555`,
    productId: "app.convos.subs.monthly",
    tier: SUBSCRIPTION_TIER_PLUS,
    period: SubscriptionPeriod.monthly,
    status: SubscriptionStatus.active,
    originalTransactionId: `otid-${accountId}`,
    transactionId: `tx-${accountId}`,
    startedAt: PERIOD_START,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    willRenew: true,
    isInTrial: false,
    environment: AppleEnv.sandbox,
    signedPayload: "stub.jws",
  });

const writeConsume = async (
  accountId: string,
  credits: number,
  createdAt: Date,
  key: string,
) => {
  // Direct ledger write bypassing the service to control createdAt for tests.
  // Balance row needs to exist (FK to UserCredits is implicit via service flow,
  // but ledger doesn't FK to UserCredits — only to Account). Seed UserCredits
  // separately if not present to keep getBalance() happy.
  await prisma.userCredits.upsert({
    where: { accountId },
    update: { balance: { decrement: BigInt(credits) } },
    create: { accountId, balance: BigInt(-credits) },
  });
  await prisma.creditLedger.create({
    data: {
      accountId,
      delta: BigInt(-credits),
      reason: LedgerReason.consume,
      idempotencyKey: key,
      createdAt,
    },
  });
};

type BalanceBody = {
  balance: number;
  monthlyGrant: number;
  monthlyGrantUsed: number;
  nextRefreshAt: string;
  periodLabel: string;
};

describe("GET /v2/accounts/me/credits", () => {
  test("returns 403 when JWT carries no accountId", async () => {
    const token = await createJwtToken({ deviceId: "dev-no-account" });
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(403);
  });

  test("no subscription: returns free-tier daily shape (balance:0, cap:100, periodLabel:Daily)", async () => {
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
    const body = res.body as BalanceBody;
    expect(body.balance).toBe(0);
    expect(body.monthlyGrant).toBe(100);
    expect(body.monthlyGrantUsed).toBe(100);
    expect(body.periodLabel).toBe("Daily");
    expect(new Date(body.nextRefreshAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("active Builder monthly with zero consumes: balance == monthlyGrant", async () => {
    const accountId = await newAccount();
    await seedPlusMonthly(accountId);
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrant).toBe(2500);
    expect(body.monthlyGrantUsed).toBe(0);
    expect(body.balance).toBe(2500);
    expect(body.nextRefreshAt).toBe(PERIOD_END.toISOString());
    expect(body.periodLabel).toBe(PERIOD_LABEL);
  });

  // Expired and past-ended subscriptions now fall through to the free-tier
  // daily-refill branch (PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = 100 in tests),
  // not a hard zero — see src/api/v2/accounts/handlers/credits-get.ts. The
  // earlier "zero-state" assertion pre-dated the daily-refill cron landing on
  // otr-dev.
  test("expired subscription status returns free-tier daily-cap credits", async () => {
    const accountId = await newAccount();
    await upsertFromVerify({
      provider: BillingProvider.apple,
      accountId,
      appAccountToken: "99999999-2222-3333-4444-555555555555",
      productId: "app.convos.subs.monthly",
      tier: SUBSCRIPTION_TIER_PLUS,
      period: SubscriptionPeriod.monthly,
      status: SubscriptionStatus.expired,
      originalTransactionId: `otid-expired-${accountId}`,
      transactionId: `tx-expired-${accountId}`,
      startedAt: new Date("2026-05-01T00:00:00.000Z"),
      currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
      willRenew: false,
      isInTrial: false,
      environment: AppleEnv.sandbox,
      signedPayload: "stub.jws",
    });
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrant).toBe(100);
    expect(body.monthlyGrantUsed).toBe(100);
    expect(body.balance).toBe(0);
    expect(body.periodLabel).toBe("Daily");
  });

  test("past-ended active subscription returns free-tier daily-cap credits", async () => {
    const accountId = await newAccount();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await upsertFromVerify({
      provider: BillingProvider.apple,
      accountId,
      appAccountToken: "88888888-2222-3333-4444-555555555555",
      productId: "app.convos.subs.monthly",
      tier: SUBSCRIPTION_TIER_PLUS,
      period: SubscriptionPeriod.monthly,
      status: SubscriptionStatus.active,
      originalTransactionId: `otid-past-active-${accountId}`,
      transactionId: `tx-past-active-${accountId}`,
      startedAt: new Date(yesterday.getTime() - 30 * 24 * 60 * 60 * 1000),
      currentPeriodStart: new Date(
        yesterday.getTime() - 30 * 24 * 60 * 60 * 1000,
      ),
      currentPeriodEnd: yesterday,
      willRenew: true,
      isInTrial: false,
      environment: AppleEnv.sandbox,
      signedPayload: "stub.jws",
    });
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrant).toBe(100);
    expect(body.monthlyGrantUsed).toBe(100);
    expect(body.balance).toBe(0);
    expect(body.periodLabel).toBe("Daily");
  });

  test("consumes within current period count against monthlyGrantUsed", async () => {
    const accountId = await newAccount();
    await seedPlusMonthly(accountId);
    await writeConsume(accountId, 300, WITHIN_PERIOD_A, "c1");
    await writeConsume(accountId, 200, WITHIN_PERIOD_B, "c2");
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrantUsed).toBe(500);
    expect(body.balance).toBe(2500 - 500);
    expect(BigInt(body.balance)).toBe(await getSpendableBalance(accountId));
  });

  test("consumes before currentPeriodStart do NOT count (previous period burn)", async () => {
    const accountId = await newAccount();
    await seedPlusMonthly(accountId);
    // Burn in the prior period — should not affect this period's display.
    await writeConsume(accountId, 9999, BEFORE_PERIOD, "previous-period");
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrantUsed).toBe(0);
    expect(body.balance).toBe(2500);
  });

  test("monthlyGrantUsed is capped at monthlyGrant (over-burn doesn't go negative)", async () => {
    const accountId = await newAccount();
    await seedPlusMonthly(accountId);
    await writeConsume(accountId, 9999, WITHIN_PERIOD_A, "huge");
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrantUsed).toBe(2500);
    expect(body.balance).toBe(0);
  });

  test("Plus annual: monthlyGrant = 12 × monthly amount", async () => {
    const accountId = await newAccount();
    await upsertFromVerify({
      provider: BillingProvider.apple,
      accountId,
      appAccountToken: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      productId: "app.convos.subs.annual",
      tier: SUBSCRIPTION_TIER_PLUS,
      period: SubscriptionPeriod.annual,
      status: SubscriptionStatus.active,
      originalTransactionId: "otid-plus-annual",
      transactionId: "tx-plus-annual",
      startedAt: PERIOD_START,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PLUS_ANNUAL_END,
      willRenew: true,
      isInTrial: false,
      environment: AppleEnv.sandbox,
      signedPayload: "stub.jws",
    });
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrant).toBe(2500 * 12);
    expect(body.balance).toBe(2500 * 12);
    expect(body.nextRefreshAt).toBe(PLUS_ANNUAL_END.toISOString());
  });
});

describe("GET /v2/accounts/me/credits — free-tier (no subscription)", () => {
  test("zero balance → balance:0, monthlyGrant: cap, monthlyGrantUsed: cap, periodLabel: Daily", async () => {
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
    const body = res.body as BalanceBody;
    expect(body.balance).toBe(0);
    expect(body.monthlyGrant).toBe(100);
    expect(body.monthlyGrantUsed).toBe(100);
    expect(body.periodLabel).toBe("Daily");
    expect(typeof body.nextRefreshAt).toBe("string");
  });

  test("partial balance (60) → balance:60, monthlyGrantUsed:40", async () => {
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    await prisma.userCredits.create({ data: { accountId, balance: 60n } });
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.balance).toBe(60);
    expect(body.monthlyGrant).toBe(100);
    expect(body.monthlyGrantUsed).toBe(40);
  });

  test("balance above cap (150) → balance:150, monthlyGrantUsed:0", async () => {
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    await prisma.userCredits.create({ data: { accountId, balance: 150n } });
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.balance).toBe(150);
    expect(body.monthlyGrant).toBe(100);
    expect(body.monthlyGrantUsed).toBe(0);
  });

  test("negative balance → balance:0 (clamped), monthlyGrantUsed:cap", async () => {
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    await prisma.userCredits.create({ data: { accountId, balance: -50n } });
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.balance).toBe(0);
    expect(body.monthlyGrant).toBe(100);
    expect(body.monthlyGrantUsed).toBe(100);
  });

  test("expired subscription → takes free-tier branch (NOT stale tierGrant)", async () => {
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const { randomUUID } = await import("node:crypto");
    await prisma.subscription.create({
      data: {
        accountId,
        provider: BillingProvider.apple,
        productId: "app.convos.subs.monthly",
        tier: SUBSCRIPTION_TIER_PLUS,
        period: SubscriptionPeriod.monthly,
        status: SubscriptionStatus.expired,
        originalTransactionId: `otx-expired-${accountId}`,
        appAccountToken: randomUUID(),
        startedAt: new Date("2026-04-01"),
        currentPeriodStart: new Date("2026-04-01"),
        currentPeriodEnd: new Date("2026-05-01"),
        environment: AppleEnv.sandbox,
      },
    });
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
    const body = res.body as BalanceBody;
    expect(body.periodLabel).toBe("Daily");
    expect(body.monthlyGrant).toBe(100);
  });
});
