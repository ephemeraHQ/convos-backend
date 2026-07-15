import {
  BillingProvider,
  SubscriptionPeriod,
  SubscriptionStatus,
} from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  listBrokenSubscribers,
  listByActivity,
  listByBalance,
  listByGrantKind,
} from "@/api/v2/credits-admin/accounts-repository";
import { prisma } from "@/utils/prisma";
import {
  cleanupAdminAccounts,
  seedAccount,
  seedPlusMonthlySubscription,
} from "./helpers";

const DAY_MS = 86400000;

/**
 * Hand-seeds a Subscription in a specific entitlement state. The shared
 * seedPlusMonthlySubscription only ever writes `active`, so the grace /
 * billingRetry / expired branches of the listBrokenSubscribers LATERAL are
 * unreachable through it. Writes the row directly (no BillingReceipt) rather
 * than widening the shared helper, which ~64 other credits-admin tests use.
 *
 * Dates are anchored relative to now() — handlers judge entitlement against
 * wall-clock now(), so absolute dates time-bomb CI.
 */
const seedSubscriptionInState = async (
  accountId: string,
  status: SubscriptionStatus,
  opts: { currentPeriodEnd: Date; gracePeriodEnd?: Date },
) => {
  const start = new Date(Date.now() - 35 * DAY_MS);
  await prisma.subscription.create({
    data: {
      accountId,
      provider: BillingProvider.apple,
      productId: "app.convos.subs.monthly",
      tier: "plus",
      period: SubscriptionPeriod.monthly,
      status,
      originalTransactionId: `otid-state-${accountId}`,
      startedAt: start,
      currentPeriodStart: start,
      currentPeriodEnd: opts.currentPeriodEnd,
      gracePeriodEnd: opts.gracePeriodEnd ?? null,
    },
  });
};

const setBalance = async (accountId: string, balance: bigint) => {
  await prisma.userCredits.upsert({
    where: { accountId },
    update: { balance },
    create: { accountId, balance },
  });
};

const addLedger = async (
  accountId: string,
  reason: "grant" | "consume" | "adjust",
  delta: bigint,
  grantKindId: string | null,
  createdAt: Date,
) => {
  await prisma.creditLedger.create({
    data: {
      accountId,
      delta,
      reason,
      grantKindId,
      idempotencyKey: `k_${accountId}_${createdAt.getTime()}_${Math.abs(Number(delta))}`,
      createdAt,
    },
  });
};

describe("accounts-repository", () => {
  const tracker: string[] = [];
  afterEach(async () => {
    for (const a of tracker) {
      await prisma.creditLedger.deleteMany({ where: { accountId: a } });
      await prisma.userCredits.deleteMany({ where: { accountId: a } });
      // BillingReceipt FKs to Subscription; must go first or the delete
      // below throws (seedPlusMonthlySubscription writes both rows).
      // Mirrors tests/credits/helpers.ts cleanupAccounts' order.
      await prisma.billingReceipt.deleteMany({
        where: { subscription: { accountId: a } },
      });
      await prisma.subscription.deleteMany({ where: { accountId: a } });
    }
    await cleanupAdminAccounts(tracker);
    tracker.length = 0;
  });

  it("listByBalance filters by min/max and sorts", async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    const c = await seedAccount();
    tracker.push(a, b, c);
    await setBalance(a, 100n);
    await setBalance(b, -50n);
    await setBalance(c, 5000n);
    // scope to the seeded ids — this is a GLOBAL query and the test DB is shared.
    const desc = await listByBalance({ sort: "desc", limit: 1000 });
    const ids = desc.rows
      .map((r) => r.accountId)
      .filter((id) => [a, b, c].includes(id));
    expect(ids).toEqual([c, a, b]); // 5000, 100, -50
    const ranged = await listByBalance({ min: 0, max: 1000, limit: 1000 });
    const rIds = ranged.rows.map((r) => r.accountId);
    expect(rIds).toContain(a);
    expect(rIds).not.toContain(b);
    expect(rIds).not.toContain(c);
  });

  it("listByBalance paginates with hasMore", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const x = await seedAccount();
      ids.push(x);
      tracker.push(x);
      await setBalance(x, BigInt(i));
    }
    const p0 = await listByBalance({ sort: "asc", page: 0, limit: 2 });
    expect(p0.rows).toHaveLength(2);
    expect(p0.hasMore).toBe(true);
  });

  it("listBrokenSubscribers finds entitled sub with balance <= maxBalance (incl. 0)", async () => {
    const broken = await seedAccount();
    const healthy = await seedAccount();
    tracker.push(broken, healthy);
    await seedPlusMonthlySubscription(broken);
    await seedPlusMonthlySubscription(healthy);
    await setBalance(broken, 0n);
    await setBalance(healthy, 100000n);
    // limit: 1000 — this is a GLOBAL query on a shared DB; a small limit would
    // let concurrent fixtures push the seeded row off page 1 and flake.
    const res = await listBrokenSubscribers({ maxBalance: 0, limit: 1000 });
    const ids = res.rows.map((r) => r.accountId);
    expect(ids).toContain(broken); // balance == 0 must appear
    expect(ids).not.toContain(healthy);
    expect(res.rows.find((r) => r.accountId === broken)?.tier).toBeTruthy();
  });

  it("listBrokenSubscribers includes a grace sub whose gracePeriodEnd is future", async () => {
    const graced = await seedAccount();
    tracker.push(graced);
    // Period already ended; the grace window is what still entitles them —
    // so this also pins the COALESCE(gracePeriodEnd, currentPeriodEnd) arm.
    await seedSubscriptionInState(graced, SubscriptionStatus.grace, {
      currentPeriodEnd: new Date(Date.now() - 2 * DAY_MS),
      gracePeriodEnd: new Date(Date.now() + 14 * DAY_MS),
    });
    await setBalance(graced, 0n);
    const res = await listBrokenSubscribers({ maxBalance: 0, limit: 1000 });
    expect(res.rows.map((r) => r.accountId)).toContain(graced);
  });

  it("listBrokenSubscribers includes a billingRetry sub regardless of period end", async () => {
    const retrying = await seedAccount();
    tracker.push(retrying);
    // billingRetry has no TTL check in the LATERAL — a past currentPeriodEnd
    // must NOT disqualify it.
    await seedSubscriptionInState(retrying, SubscriptionStatus.billingRetry, {
      currentPeriodEnd: new Date(Date.now() - 10 * DAY_MS),
    });
    await setBalance(retrying, 0n);
    const res = await listBrokenSubscribers({ maxBalance: 0, limit: 1000 });
    expect(res.rows.map((r) => r.accountId)).toContain(retrying);
  });

  it("listBrokenSubscribers excludes a lapsed sub (active status, period ended)", async () => {
    const lapsed = await seedAccount();
    tracker.push(lapsed);
    // Stale `active` row whose period has run out — the active/trial arm's
    // `currentPeriodEnd > now()` guard must exclude it despite balance 0.
    await seedSubscriptionInState(lapsed, SubscriptionStatus.active, {
      currentPeriodEnd: new Date(Date.now() - 1 * DAY_MS),
    });
    await setBalance(lapsed, 0n);
    const res = await listBrokenSubscribers({ maxBalance: 0, limit: 1000 });
    expect(res.rows.map((r) => r.accountId)).not.toContain(lapsed);
  });

  it("listByGrantKind lists accounts with that kind, latest-first", async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    tracker.push(a, b);
    await setBalance(a, 0n);
    await setBalance(b, 0n);
    await addLedger(
      a,
      "grant",
      10n,
      "signup_bonus",
      new Date("2026-07-01T00:00:00Z"),
    );
    await addLedger(
      b,
      "grant",
      10n,
      "signup_bonus",
      new Date("2026-07-10T00:00:00Z"),
    );
    await addLedger(
      a,
      "grant",
      10n,
      "daily_refill",
      new Date("2026-07-11T00:00:00Z"),
    );
    const res = await listByGrantKind({ kind: "signup_bonus", limit: 1000 });
    // scope to seeded ids — global query on a shared DB.
    const ids = res.rows
      .map((r) => r.accountId)
      .filter((id) => [a, b].includes(id));
    expect(ids).toEqual([b, a]); // b's signup_bonus is newer
  });

  it("listByActivity active vs dormant split on last consume", async () => {
    const active = await seedAccount();
    const dormant = await seedAccount();
    const never = await seedAccount();
    tracker.push(active, dormant, never);
    await setBalance(active, 0n);
    await setBalance(dormant, 0n);
    await setBalance(never, 0n);
    const now = new Date();
    await addLedger(
      active,
      "consume",
      -5n,
      null,
      new Date(now.getTime() - 2 * 86400000),
    );
    await addLedger(
      dormant,
      "consume",
      -5n,
      null,
      new Date(now.getTime() - 90 * 86400000),
    );
    // `never` has no consume rows
    const act = await listByActivity({
      state: "active",
      days: 30,
      limit: 1000,
    });
    const dor = await listByActivity({
      state: "dormant",
      days: 30,
      limit: 1000,
    });
    const actIds = act.rows.map((r) => r.accountId);
    const dorIds = dor.rows.map((r) => r.accountId);
    expect(actIds).toContain(active);
    expect(actIds).not.toContain(dormant);
    expect(dorIds).toContain(dormant);
    expect(dorIds).toContain(never); // never-consumed is dormant
    expect(dorIds).not.toContain(active);
  });
});
