import { LedgerReason } from "@prisma/client";
import { getBalance } from "@/payments";
import { config } from "@/payments/credits/config";
import { findCurrentByAccountId } from "@/subscriptions/repository";
import { isEntitledSubscription } from "@/subscriptions/status";
import { tierGrant } from "@/subscriptions/tier-config";
import { requireSubscriptionTier } from "@/subscriptions/tiers";
import { prisma } from "@/utils/prisma";

export const sumPeriodConsumes = async (
  accountId: string,
  since: Date,
): Promise<number> => {
  const agg = await prisma.creditLedger.aggregate({
    where: {
      accountId,
      reason: LedgerReason.consume,
      createdAt: { gte: since },
    },
    _sum: { delta: true },
  });
  const sum = agg._sum.delta;
  if (sum === null) return 0;
  return Number(sum < 0n ? -sum : sum);
};

export const getSpendableBalance = async (
  accountId: string,
): Promise<bigint> => {
  const subscription = await findCurrentByAccountId(accountId);
  if (subscription && isEntitledSubscription(subscription)) {
    const grant = tierGrant(
      requireSubscriptionTier(subscription.tier),
      subscription.period,
    );
    const used = await sumPeriodConsumes(
      accountId,
      subscription.currentPeriodStart,
    );
    const remaining = grant.perPeriod - Math.min(used, grant.perPeriod);
    return BigInt(remaining);
  }
  return getBalance(accountId);
};

export const isSpendAllowed = async (accountId: string): Promise<boolean> =>
  (await getSpendableBalance(accountId)) >= config.reservedMaxTurnCredits;
