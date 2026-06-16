import { randomUUID } from "node:crypto";
import { LedgerReason, SubscriptionPeriod } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/payments/credits/config";
import { getSpendableBalance, isSpendAllowed } from "@/payments/spendable";
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
