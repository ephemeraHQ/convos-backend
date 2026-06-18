import { randomUUID } from "node:crypto";
import { LedgerReason, SubscriptionPeriod } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import { getBalance, getBucketedConsumption } from "@/payments";
import { config } from "@/payments/credits/config";
import {
  getSpendableBalance,
  isSpendAllowed,
  recordConsume,
} from "@/payments/spendable";
import { tierGrant } from "@/subscriptions/tier-config";
import { SUBSCRIPTION_TIER_PLUS } from "@/subscriptions/tiers";
import { prisma } from "@/utils/prisma";
import {
  cleanupAccounts,
  seedAccount,
  seedBalance,
  seedExpiredSubscription,
  seedPlusMonthlySubscription,
} from "./helpers";

const tracker: string[] = [];
afterEach(async () => {
  await cleanupAccounts(tracker);
  tracker.length = 0;
});

const perPeriod = () =>
  tierGrant(SUBSCRIPTION_TIER_PLUS, SubscriptionPeriod.monthly).perPeriod;

const writeConsume = async (accountId: string, credits: number) => {
  await prisma.creditLedger.create({
    data: {
      accountId,
      delta: BigInt(-credits),
      reason: LedgerReason.consume,
      idempotencyKey: `c-${randomUUID()}`,
      scope: "transaction",
    },
  });
};

describe("getSpendableBalance / isSpendAllowed", () => {
  it("non-subscriber → raw ledger balance", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 4242n);
    expect(await getSpendableBalance(accountId)).toBe(4242n);
    expect(await isSpendAllowed(accountId)).toBe(true);
  });

  it("non-subscriber, no row → 0 and not allowed", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    expect(await getSpendableBalance(accountId)).toBe(0n);
    expect(await isSpendAllowed(accountId)).toBe(false);
  });

  it("entitled subscriber → perPeriod − periodConsumes", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await writeConsume(accountId, 100);
    expect(await getSpendableBalance(accountId)).toBe(
      BigInt(perPeriod() - 100),
    );
    expect(await isSpendAllowed(accountId)).toBe(true);
  });

  it("entitled subscriber at/over cap → 0 and not allowed", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await writeConsume(accountId, perPeriod() + 50);
    expect(await getSpendableBalance(accountId)).toBe(0n);
    expect(await isSpendAllowed(accountId)).toBe(
      config.reservedMaxTurnCredits <= 0n,
    );
  });

  it("lapsed subscriber → falls through to raw ledger balance", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedExpiredSubscription(accountId);
    await seedBalance(accountId, 1234n);
    // Subscription row exists but is not entitled → raw additive balance, not derived.
    expect(await getSpendableBalance(accountId)).toBe(1234n);
  });
});

describe("recordConsume", () => {
  it("subscriber → ledger row written, raw balance untouched, never throws", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);

    const res = await recordConsume({
      accountId,
      usdCostMicros: 1_000_000n,
      idempotencyKey: `t-${randomUUID()}`,
      requestId: "req-1",
    });
    expect(res.spent).toBeGreaterThan(0);

    // Raw balance untouched (no UserCredits row created).
    expect(await getBalance(accountId)).toBe(0n);
    // Usage is recorded → spendable dropped by the consumed amount.
    expect(await getSpendableBalance(accountId)).toBe(
      BigInt(perPeriod() - res.spent),
    );
    const rows = await prisma.creditLedger.count({
      where: { accountId, reason: LedgerReason.consume },
    });
    expect(rows).toBe(1);
  });

  it("non-subscriber → identical to consume() (decrements raw balance)", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 5000n);

    const res = await recordConsume({
      accountId,
      usdCostMicros: 1_000_000n,
      idempotencyKey: `t-${randomUUID()}`,
      requestId: "req-2",
    });
    expect(await getBalance(accountId)).toBe(5000n - BigInt(res.spent));
  });

  it("subscriber idempotent replay → single row, replayed: true", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const key = `t-${randomUUID()}`;

    const first = await recordConsume({
      accountId,
      usdCostMicros: 1_000_000n,
      idempotencyKey: key,
      requestId: "req-r",
    });
    const second = await recordConsume({
      accountId,
      usdCostMicros: 1_000_000n,
      idempotencyKey: key,
      requestId: "req-r",
    });

    expect(second.replayed).toBe(true);
    expect(second.ledgerId).toBe(first.ledgerId);
    const rows = await prisma.creditLedger.count({
      where: { accountId, reason: LedgerReason.consume },
    });
    expect(rows).toBe(1);
  });

  it("record-only subscriber consume surfaces in bucketed consumption", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const res = await recordConsume({
      accountId,
      usdCostMicros: 1_000_000n,
      idempotencyKey: `u-${randomUUID()}`,
      requestId: "req-u",
    });

    const buckets = await getBucketedConsumption(accountId, since, "day");
    const total = buckets.reduce((n, b) => n + Number(b.consumed), 0);
    expect(total).toBe(res.spent);
  });
});
