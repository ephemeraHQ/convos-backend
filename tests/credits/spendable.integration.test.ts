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

describe("getSpendableBalance / isSpendAllowed (single-ledger)", () => {
  it("non-subscriber → the one wallet balance", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 4242n);
    expect(await getSpendableBalance(accountId)).toBe(4242n);
    expect(await getSpendableBalance(accountId)).toBe(
      await getBalance(accountId),
    );
    expect(await isSpendAllowed(accountId)).toBe(true);
  });

  it("non-subscriber, no row → 0 and not allowed", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    expect(await getSpendableBalance(accountId)).toBe(0n);
    expect(await isSpendAllowed(accountId)).toBe(false);
  });

  it("subscriber → the same one wallet (materialized sub_grant)", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    // Single-ledger: subscribing wrote perPeriod into the wallet; spendable is
    // just that wallet — no derivation, identical to getBalance.
    expect(await getSpendableBalance(accountId)).toBe(BigInt(perPeriod()));
    expect(await getSpendableBalance(accountId)).toBe(
      await getBalance(accountId),
    );
    expect(await isSpendAllowed(accountId)).toBe(true);
  });

  it("subscriber wallet drained → 0 and not allowed", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    // Real decrement through the wallet down to exactly 0.
    await recordConsume({
      accountId,
      usdCostMicros: BigInt(perPeriod() * 500),
      idempotencyKey: `t-${randomUUID()}`,
      requestId: "drain",
    });
    expect(await getSpendableBalance(accountId)).toBe(0n);
    expect(await isSpendAllowed(accountId)).toBe(
      config.reservedMaxTurnCredits <= 0n,
    );
  });

  it("lapsed subscriber → still just the one wallet balance", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedExpiredSubscription(accountId);
    await seedBalance(accountId, 1234n);
    // Expired sub does not materialize a grant; the wallet is the raw balance.
    expect(await getSpendableBalance(accountId)).toBe(1234n);
  });
});

describe("recordConsume (single-ledger — one debit path)", () => {
  it("subscriber → real decrement of the shared wallet", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const before = await getBalance(accountId);

    const res = await recordConsume({
      accountId,
      usdCostMicros: 1_000_000n,
      idempotencyKey: `t-${randomUUID()}`,
      requestId: "req-1",
    });
    expect(res.spent).toBeGreaterThan(0);

    // Wallet moved by exactly the spent amount (no record-only no-op).
    expect(await getBalance(accountId)).toBe(before - BigInt(res.spent));
    expect(await getSpendableBalance(accountId)).toBe(
      before - BigInt(res.spent),
    );
    const rows = await prisma.creditLedger.count({
      where: { accountId, reason: LedgerReason.consume },
    });
    expect(rows).toBe(1);
  });

  it("admin + subscription credits are spent uniformly from the one balance", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await seedBalance(accountId, 1_000n); // admin/manual credits on top

    const before = await getBalance(accountId);
    expect(before).toBe(BigInt(perPeriod()) + 1_000n);

    const res = await recordConsume({
      accountId,
      usdCostMicros: 1_000_000n,
      idempotencyKey: `t-${randomUUID()}`,
      requestId: "req-mix",
    });
    // Single pooled balance: no distinction between sub vs admin credits.
    expect(await getBalance(accountId)).toBe(before - BigInt(res.spent));
  });

  it("non-subscriber → identical to consume() (decrements the wallet)", async () => {
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

  it("subscriber idempotent replay → single row, replayed: true, no double debit", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const before = await getBalance(accountId);
    const key = `t-${randomUUID()}`;

    // Small spend so the replay attempt does not trip the floor before the
    // idempotency short-circuit (the floor is checked before the insert).
    const first = await recordConsume({
      accountId,
      usdCostMicros: 50_000n,
      idempotencyKey: key,
      requestId: "req-r",
    });
    const second = await recordConsume({
      accountId,
      usdCostMicros: 50_000n,
      idempotencyKey: key,
      requestId: "req-r",
    });

    expect(second.replayed).toBe(true);
    expect(second.ledgerId).toBe(first.ledgerId);
    // Debited once, not twice.
    expect(await getBalance(accountId)).toBe(before - BigInt(first.spent));
    const rows = await prisma.creditLedger.count({
      where: { accountId, reason: LedgerReason.consume },
    });
    expect(rows).toBe(1);
  });

  it("subscriber consume surfaces in bucketed consumption", async () => {
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
