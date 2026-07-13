import { LedgerReason } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { accountsMeRouter } from "@/api/v2/accounts/accountsMeRouter";
import { REFILL_DISABLED_PERIOD_LABEL } from "@/api/v2/accounts/handlers/credits-get";
import { authMiddleware } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { config } from "@/payments/credits/config";
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

  // Single-ledger: a still-`active` subscription whose period window has
  // elapsed (no EXPIRED webhook yet) is time-expired for *display* — the
  // credits endpoint frames it as the free-tier daily branch (cap 100,
  // periodLabel "Daily"). But the per-period `sub_grant` that `upsertFromVerify`
  // materialized on subscribe stays in the one wallet until an
  // expiry/refund/revoke webhook forfeits it (covered by grants.integration).
  // So the wallet still shows the granted balance, and `monthlyGrantUsed`
  // (= max(0, cap − balance)) clamps to 0, NOT the cap. The old assertion
  // (used = cap, balance = 0) encoded the pre-single-ledger derived-balance
  // model where lapsing instantly zeroed the wallet.
  test("past-ended active subscription: daily-cap framing, wallet credits persist until forfeit", async () => {
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
    expect(body.monthlyGrantUsed).toBe(0);
    expect(body.balance).toBe(2500);
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

  // `monthlyGrantUsed` for entitled subscribers is `min(periodConsumes, grant)`
  // where `periodConsumes` is |consume deltas| since `currentPeriodStart` — it
  // windows consumes by `createdAt >= currentPeriodStart` and does NOT derive
  // from the commingled wallet balance (which admin/promo/signup credits share).
  // Here the 9999-credit burn is dated BEFORE the current period, so it is
  // excluded from `periodConsumes` → used is 0. The debit still drains the one
  // wallet, so the displayed balance clamps to 0 (raw `getSpendableBalance`
  // stays negative — that's the spend gate's concern, not the display's).
  test("out-of-period consume is excluded from monthlyGrantUsed but still drains the wallet", async () => {
    const accountId = await newAccount();
    await seedPlusMonthly(accountId);
    await writeConsume(accountId, 9999, BEFORE_PERIOD, "previous-period");
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrantUsed).toBe(0);
    // Wallet overshot to negative; the endpoint clamps the displayed balance to
    // 0 (the raw `getSpendableBalance` stays negative — that's the spend gate's
    // concern, not the display's).
    expect(body.balance).toBe(0);
    expect(await getSpendableBalance(accountId)).toBeLessThan(0n);
  });

  // FIX 2 regression: a subscriber with extra admin credits on top of the period
  // grant who has consumed within the period must report the REAL consumes as
  // `monthlyGrantUsed` (capped at the grant), NOT 0. The old wallet-derived
  // `clamp(grant − balance)` returned 0 here because the admin credits kept the
  // balance above the grant.
  test("admin credits on top of the grant: monthlyGrantUsed reflects period consumes, not 0", async () => {
    const accountId = await newAccount();
    await seedPlusMonthly(accountId); // wallet = 2500 (sub_grant)
    // Admin/promo credits on top of the subscription grant.
    await prisma.userCredits.update({
      where: { accountId },
      data: { balance: { increment: 1000n } },
    });
    await prisma.creditLedger.create({
      data: {
        accountId,
        delta: 1000n,
        reason: LedgerReason.grant,
        idempotencyKey: `admin-${accountId}`,
        scope: "grant",
        grantKindId: "manual",
      },
    });
    // Consume 700 within the current period.
    await writeConsume(accountId, 700, WITHIN_PERIOD_A, "spend-700");
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    // Wallet = 2500 + 1000 − 700 = 2800 (above the 2500 grant), yet usage is the
    // real 700 of period consumes — NOT clamp(2500 − 2800) = 0.
    expect(body.balance).toBe(2800);
    expect(body.monthlyGrant).toBe(2500);
    expect(body.monthlyGrantUsed).toBe(700);
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

  // Daily-refill kill-switch (cap = 0): the refill is intentionally
  // deactivated, so the endpoint must stop promising a FUTURE refresh. iOS's
  // shipped `CreditBalance` model requires `nextRefreshAt` as a non-optional
  // Date, so the key stays present — the response mirrors the iOS design
  // fixture `CreditsStatePreset.noSubNoTrial` exactly (grant/used 0,
  // nextRefreshAt = now, periodLabel "—") so shipped binaries render a state
  // design already signed off. See REFILL_DISABLED_PERIOD_LABEL in the
  // handler for the full shipped-client analysis.
  describe("daily refill disabled (cap = 0)", () => {
    const originalCap = config.freeTierDailyCapCredits;

    afterEach(() => {
      config.freeTierDailyCapCredits = originalCap;
    });

    test("no future refresh advertised; combo mirrors the iOS free-state fixture", async () => {
      config.freeTierDailyCapCredits = 0;
      const accountId = await newAccount();
      const token = await tokenFor(accountId);
      await prisma.userCredits.create({ data: { accountId, balance: 60n } });
      const before = Date.now();
      const res = await request(makeApp())
        .get("/v2/accounts/me/credits")
        .set("X-Convos-AuthToken", token);
      const after = Date.now();
      expect(res.status).toBe(200);
      const body = res.body as BalanceBody;
      expect(body.balance).toBe(60);
      expect(body.monthlyGrant).toBe(0);
      // No cap → nothing to have "used" against it.
      expect(body.monthlyGrantUsed).toBe(0);
      // The assertion that matters: nextRefreshAt is NOW (request time), not
      // tomorrow — no forward promise, matching the fixture's `now`.
      const next = new Date(body.nextRefreshAt).getTime();
      expect(Number.isNaN(next)).toBe(false);
      expect(next).toBeGreaterThanOrEqual(before);
      expect(next).toBeLessThanOrEqual(after);
      // Fixture's period label for the no-grant state.
      expect(body.periodLabel).toBe(REFILL_DISABLED_PERIOD_LABEL);
      expect(body.periodLabel).toBe("—");
    });

    test("re-enabling the cap restores the daily-refresh advertisement unchanged", async () => {
      config.freeTierDailyCapCredits = originalCap;
      const accountId = await newAccount();
      const token = await tokenFor(accountId);
      const res = await request(makeApp())
        .get("/v2/accounts/me/credits")
        .set("X-Convos-AuthToken", token);
      const body = res.body as BalanceBody;
      expect(body.monthlyGrant).toBe(originalCap);
      expect(body.periodLabel).toBe("Daily");
      const next = new Date(body.nextRefreshAt).getTime();
      expect(next).toBeGreaterThan(Date.now());
      // Within the next 24h — i.e. start of next UTC day, not "now".
      expect(next).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    });
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
