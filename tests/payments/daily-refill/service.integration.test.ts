import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { LedgerReason } from "@prisma/client";
import { getBalance } from "@/payments";
import { runDailyRefill } from "@/payments/daily-refill/service";
import { ymdUtc } from "@/payments/daily-refill/utc";
import { applyDelta } from "@/payments/ledger/repository";
import { prisma } from "@/utils/prisma";

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

async function seedAccount(opts?: { withAuthMethod?: boolean }): Promise<string> {
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
    expect(summarySecond.refilled.map((r) => r.accountId)).not.toContain(accountId);
    // Balance must remain at 40n — no double-credit.
    expect(await balanceOf(accountId)).toBe(40n);
  });
});
