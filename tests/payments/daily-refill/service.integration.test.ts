import { randomUUID } from "node:crypto";
import { LedgerReason } from "@prisma/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getBalance } from "@/payments";
import { runDailyRefill } from "@/payments/daily-refill/service";
import { ymdUtc } from "@/payments/daily-refill/utc";
import { applyDelta } from "@/payments/ledger/repository";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");
vi.mock("jsonwebtoken");

const tracker: string[] = [];

afterEach(async () => {
  for (const accountId of tracker) {
    await prisma.subscription.deleteMany({ where: { accountId } });
    await prisma.creditLedger.deleteMany({ where: { accountId } });
    await prisma.userCredits.deleteMany({ where: { accountId } });
    await prisma.authMethod.deleteMany({ where: { accountId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
  }
  tracker.length = 0;
});

async function seedAccount(opts?: {
  withAuthMethod?: boolean;
}): Promise<string> {
  const acct = await prisma.account.create({ data: {} });
  tracker.push(acct.id);
  if (opts?.withAuthMethod ?? true) {
    await prisma.authMethod.create({
      data: {
        accountId: acct.id,
        type: "SIWE",
        externalKey: `0x${randomUUID().replace(/-/g, "")}`,
      },
    });
  }
  return acct.id;
}

async function balanceOf(accountId: string): Promise<bigint> {
  return getBalance(accountId);
}

async function seedActiveSubscription(accountId: string): Promise<void> {
  await prisma.subscription.create({
    data: {
      accountId,
      productId: "com.example.builder.monthly",
      tier: "builder",
      period: "monthly",
      status: "active",
      originalTransactionId: `otx-${randomUUID()}`,
      appAccountToken: randomUUID(),
      startedAt: new Date("2026-05-01"),
      currentPeriodStart: new Date("2026-05-01"),
      currentPeriodEnd: new Date("2026-06-01"),
      environment: "production",
    },
  });
}

const NOW = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));

// Helper: write a rate-limit anchor row directly with controlled createdAt.
// CRITICAL: do NOT rely on runDailyRefill to write the first anchor — its
// CreditLedger row uses server clock (`@default(now())`) which may not
// match the injected `now`. The mismatch causes date-dependent flakes
// when the suite runs near a UTC day boundary.
async function seedRateLimitAnchor(
  accountId: string,
  createdAt: Date,
): Promise<void> {
  await prisma.creditLedger.create({
    data: {
      accountId,
      delta: 100n,
      reason: LedgerReason.grant,
      idempotencyKey: `daily_refill:${accountId}:${ymdUtc(createdAt)}-seed`,
      grantKindId: "daily_refill",
      createdAt,
    },
  });
  // Mirror in UserCredits so balance is consistent with the anchor
  await prisma.userCredits.upsert({
    where: { accountId },
    update: { balance: { increment: 100n } },
    create: { accountId, balance: 100n },
  });
}

describe("runDailyRefill — empty DB", () => {
  test("no eligible accounts → empty summary", async () => {
    const summary = await runDailyRefill({
      now: new Date(Date.UTC(2026, 4, 15, 12, 0, 0)),
    });
    expect(summary.skipped).toBe(false);
    expect(summary.refilled).toEqual([]);
    expect(summary.noOp).toBe(0);
    expect(summary.errors).toEqual([]);
  });
});

describe("runDailyRefill — eligibility", () => {
  test("includes SIWE-verified non-subscriber", async () => {
    const accountId = await seedAccount();
    const summary = await runDailyRefill({ now: NOW });
    expect(summary.refilled.map((r) => r.accountId)).toContain(accountId);
  });

  test("excludes account without AuthMethod (anonymous device-only)", async () => {
    const accountId = await seedAccount({ withAuthMethod: false });
    const summary = await runDailyRefill({ now: NOW });
    expect(summary.refilled.map((r) => r.accountId)).not.toContain(accountId);
  });

  test("excludes account with active subscription", async () => {
    const accountId = await seedAccount();
    await seedActiveSubscription(accountId);
    const summary = await runDailyRefill({ now: NOW });
    expect(summary.refilled.map((r) => r.accountId)).not.toContain(accountId);
  });

  test("includes account whose subscription is revoked (non-active status)", async () => {
    const accountId = await seedAccount();
    await prisma.subscription.create({
      data: {
        accountId,
        productId: "com.example.builder.monthly",
        tier: "builder",
        period: "monthly",
        status: "revoked",
        originalTransactionId: `otx-${randomUUID()}`,
        appAccountToken: randomUUID(),
        startedAt: new Date("2026-04-01"),
        currentPeriodStart: new Date("2026-04-01"),
        currentPeriodEnd: new Date("2026-05-01"),
        environment: "production",
      },
    });
    const summary = await runDailyRefill({ now: NOW });
    expect(summary.refilled.map((r) => r.accountId)).toContain(accountId);
  });
});

describe("runDailyRefill — top-up math", () => {
  test("zero balance → grant equal to cap (100)", async () => {
    const accountId = await seedAccount();
    // No UserCredits row → balance is 0n by default
    const summary = await runDailyRefill({ now: NOW });
    const entry = summary.refilled.find((r) => r.accountId === accountId);
    expect(entry).toBeDefined();
    expect(entry!.creditsAdded).toBe(100);
    expect(await balanceOf(accountId)).toBe(100n);
    expect(entry!.newBalance).toBe(100n);
  });

  test("balance below cap (40) → grant 60 to reach cap", async () => {
    const accountId = await seedAccount();
    // Seed 40 credits via applyDelta (direct ledger write, no grant kind needed)
    await applyDelta({
      accountId,
      delta: 40n,
      idempotencyKey: `seed-40:${accountId}`,
      reason: LedgerReason.adjust,
    });
    const summary = await runDailyRefill({ now: NOW });
    const entry = summary.refilled.find((r) => r.accountId === accountId);
    expect(entry).toBeDefined();
    expect(entry!.creditsAdded).toBe(60);
    expect(await balanceOf(accountId)).toBe(100n);
    expect(entry!.newBalance).toBe(100n);
  });

  test("balance at cap → noOp (no ledger row added)", async () => {
    const accountId = await seedAccount();
    await applyDelta({
      accountId,
      delta: 100n,
      idempotencyKey: `seed-100:${accountId}`,
      reason: LedgerReason.adjust,
    });
    const before = await balanceOf(accountId);
    const summary = await runDailyRefill({ now: NOW });
    expect(summary.refilled.map((r) => r.accountId)).not.toContain(accountId);
    expect(summary.noOp).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(accountId)).toBe(before);
  });

  test("balance above cap (150) → noOp (headroom <= 0)", async () => {
    const accountId = await seedAccount();
    await applyDelta({
      accountId,
      delta: 150n,
      idempotencyKey: `seed-150:${accountId}`,
      reason: LedgerReason.adjust,
    });
    const before = await balanceOf(accountId);
    const summary = await runDailyRefill({ now: NOW });
    expect(summary.refilled.map((r) => r.accountId)).not.toContain(accountId);
    expect(await balanceOf(accountId)).toBe(before);
  });

  test("negative balance → grant exactly cap (positiveBalance clamped to 0)", async () => {
    const accountId = await seedAccount();
    // Drive balance negative via two applyDelta calls:
    // First create the row with a positive seed, then subtract more than seeded.
    await applyDelta({
      accountId,
      delta: 10n,
      idempotencyKey: `seed-pos:${accountId}`,
      reason: LedgerReason.adjust,
    });
    await applyDelta({
      accountId,
      delta: -50n,
      idempotencyKey: `seed-neg:${accountId}`,
      reason: LedgerReason.adjust,
    });
    // balance is now -40n; positiveBalance clamps to 0n; headroom = cap = 100
    const summary = await runDailyRefill({ now: NOW });
    const entry = summary.refilled.find((r) => r.accountId === accountId);
    expect(entry).toBeDefined();
    expect(entry!.creditsAdded).toBe(100);
    expect(await balanceOf(accountId)).toBe(60n); // -40 + 100 = 60
    expect(entry!.newBalance).toBe(60n);
  });
});

describe("runDailyRefill — rate limit", () => {
  test("anchor row from today → service skips with already_ran_today", async () => {
    const accountId = await seedAccount();
    await seedRateLimitAnchor(accountId, NOW);

    const result = await runDailyRefill({ now: NOW });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("already_ran_today");
    expect(result.refilled).toEqual([]);
  });

  test("anchor row from yesterday → service runs, refills today", async () => {
    const accountId = await seedAccount();
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    await seedRateLimitAnchor(accountId, yesterday);
    // Drain so today's refill has work to do
    await prisma.userCredits.update({
      where: { accountId },
      data: { balance: 30n },
    });

    const result = await runDailyRefill({ now: NOW });
    expect(result.skipped).toBe(false);
    expect(result.refilled.map((r) => r.accountId)).toContain(accountId);
    expect(await balanceOf(accountId)).toBe(100n);
  });

  test("anchor row from today 00:01 UTC, run at today 23:59 UTC → still skipped", async () => {
    const accountId = await seedAccount();
    const earlyToday = new Date(Date.UTC(2026, 4, 15, 0, 1, 0));
    const lateToday = new Date(Date.UTC(2026, 4, 15, 23, 59, 0));
    await seedRateLimitAnchor(accountId, earlyToday);

    const result = await runDailyRefill({ now: lateToday });
    expect(result.skipped).toBe(true);
  });
});

describe("runDailyRefill — idempotency", () => {
  test("global rate-limit: second run on same UTC day returns skipped:true (no double-credit)", async () => {
    const accountId = await seedAccount();

    // First run — inserts a daily_refill ledger row, setting the global anchor.
    const summaryFirst = await runDailyRefill({ now: NOW });
    expect(summaryFirst.skipped).toBe(false);
    expect(summaryFirst.refilled.map((r) => r.accountId)).toContain(accountId);
    const balanceAfterFirst = await balanceOf(accountId);
    expect(balanceAfterFirst).toBe(100n);

    // Second run on the SAME UTC day — global rate-limit sees MAX(createdAt) >= startOfToday
    // and short-circuits immediately. No per-account grant() calls are made.
    const summarySecond = await runDailyRefill({ now: NOW });
    expect(summarySecond.skipped).toBe(true);
    expect(summarySecond.reason).toBe("already_ran_today");

    // Balance must be unchanged — no double-credit.
    expect(await balanceOf(accountId)).toBe(balanceAfterFirst);
  });

  test("per-account idempotency key replay: balance unchanged even when global rate-limit bypassed", async () => {
    const accountId = await seedAccount();

    // First run — inserts the per-account daily_refill ledger row (delta=100)
    // and sets balance to 100n.
    await runDailyRefill({ now: NOW });
    const balanceAfterFirst = await balanceOf(accountId);
    expect(balanceAfterFirst).toBe(100n);

    // Drain 60 credits so balance is 40n and headroom would be 60 on next run.
    await applyDelta({
      accountId,
      delta: -60n,
      idempotencyKey: `drain:${accountId}`,
      reason: LedgerReason.adjust,
    });
    expect(await balanceOf(accountId)).toBe(40n);

    // Backdate the daily_refill ledger row to yesterday so the global rate-limit
    // anchor (MAX createdAt WHERE grantKindId='daily_refill') falls before
    // startOfTodayUtc(NOW) → self-rate-limit check passes for second run.
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    await prisma.creditLedger.updateMany({
      where: { accountId, grantKindId: "daily_refill" },
      data: { createdAt: yesterday },
    });

    // Second run: sees balance=40n, headroom=60, calls
    //   grant({ credits: 60, idempotencyKey: "daily_refill:<accountId>:2026-05-15" })
    // The stored row has delta=100 (from the first run). The mismatch between
    // requested delta (60) and stored delta (100) triggers IdempotencyMismatchError,
    // which the service catches and logs in errors[]. Balance stays at 40n.
    // This is the correct defense: the same-day key blocks re-crediting even if
    // the headroom calculation changed mid-day (e.g., due to consumption).
    const summarySecond = await runDailyRefill({ now: NOW });
    expect(summarySecond.skipped).toBe(false);

    // Account must NOT appear in refilled — the error path fires instead.
    expect(summarySecond.refilled.map((r) => r.accountId)).not.toContain(
      accountId,
    );
    // Balance must remain at 40n — no double-credit.
    expect(await balanceOf(accountId)).toBe(40n);
  });
});

describe("runDailyRefill — failure isolation", () => {
  test("pre-seeded idempotency-key collision with mismatched payload → error for that account, others succeed", async () => {
    const goodAccountId = await seedAccount();
    const collidingAccountId = await seedAccount();

    // Pre-insert a ledger row using the same idempotency key the service
    // will generate for `collidingAccountId` today, but with a different
    // delta. The grant() call inside the service will see the prior row
    // and throw IdempotencyMismatchError.
    //
    // IMPORTANT: createdAt is set to yesterday so the global rate-limit
    // query (MAX createdAt WHERE grantKindId='daily_refill' >= startOfTodayUtc(NOW))
    // does NOT short-circuit the batch. The date-keyed idempotency key
    // ('daily_refill:<accountId>:2026-05-15') still collides with what the
    // service generates for today, triggering the mismatch error.
    const dayKey = ymdUtc(NOW);
    const collidingKey = `daily_refill:${collidingAccountId}:${dayKey}`;
    await prisma.creditLedger.create({
      data: {
        accountId: collidingAccountId,
        delta: 99n,
        reason: LedgerReason.grant,
        idempotencyKey: collidingKey,
        grantKindId: "daily_refill",
        createdAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      },
    });
    // Also reflect the delta in UserCredits so balance is internally consistent
    await prisma.userCredits.create({
      data: { accountId: collidingAccountId, balance: 99n },
    });

    const summary = await runDailyRefill({ now: NOW });

    expect(summary.refilled.map((r) => r.accountId)).toContain(goodAccountId);
    expect(summary.errors.map((e) => e.accountId)).toContain(
      collidingAccountId,
    );
    const collidingError = summary.errors.find(
      (e) => e.accountId === collidingAccountId,
    );
    expect(collidingError?.error).toMatch(/idempotency|replay|mismatch/i);
  });
});
