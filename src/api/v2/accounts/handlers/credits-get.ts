import { LedgerReason } from "@prisma/client";
import type { Request, Response } from "express";
import { getBalance } from "@/payments";
import { config } from "@/payments/credits/config";
import { startOfNextUtcDay } from "@/payments/daily-refill/utc";
import { findCurrentByAccountId } from "@/subscriptions/repository";
import { isEntitledSubscription } from "@/subscriptions/status";
import { tierGrant } from "@/subscriptions/tier-config";
import { prisma } from "@/utils/prisma";

const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const sumPeriodConsumes = async (
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
  // delta is negative for consume entries; we want the absolute total.
  const sum = agg._sum.delta;
  if (sum === null) return 0;
  // BigInt → number; cap negativity and convert.
  const positive = sum < 0n ? -sum : sum;
  return Number(positive);
};

/**
 * GET /v2/accounts/me/credits — returns the iOS `CreditBalance` shape:
 * `{ balance, monthlyGrant, monthlyGrantUsed, nextRefreshAt, periodLabel }`.
 *
 * Derivation:
 *   - With an entitled Subscription: `monthlyGrant` comes from the tier × period
 *     config; `monthlyGrantUsed` is the sum of consume-ledger deltas since
 *     `currentPeriodStart`; `balance = monthlyGrant - monthlyGrantUsed`;
 *     `nextRefreshAt = currentPeriodEnd`.
 *   - Without an entitled Subscription (free tier): balance is the daily-refill
 *     ledger value, `monthlyGrant` is the free-tier daily cap, `monthlyGrantUsed`
 *     is the cap minus the current balance, `nextRefreshAt` is the start of the
 *     next UTC day, `periodLabel` is "Daily".
 *
 * Note for v1: additive grants (NUX trial, top-ups, manual ops) outside the
 * daily-refill ledger are NOT folded into the balance display yet. The iOS
 * `CreditBalance` model doesn't yet expose a separate "bonus credits" field.
 * When that surface ships, widen this handler to include them.
 */
export async function creditsGetHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId as string;

  try {
    const subscription = await findCurrentByAccountId(accountId);

    if (!subscription || !isEntitledSubscription(subscription)) {
      const balance = await getBalance(accountId);
      const cap = config.freeTierDailyCapCredits;
      const positiveBalance = balance < 0n ? 0n : balance;
      const used = Math.max(0, cap - Number(positiveBalance));
      const now = new Date();
      res.status(200).json({
        balance: Number(positiveBalance),
        monthlyGrant: cap,
        monthlyGrantUsed: used,
        nextRefreshAt: startOfNextUtcDay(now).toISOString(),
        periodLabel: "Daily",
      });
      return;
    }

    const grant = tierGrant(subscription.tier, subscription.period);
    const rawUsed = await sumPeriodConsumes(
      accountId,
      subscription.currentPeriodStart,
    );
    const monthlyGrantUsed = Math.min(rawUsed, grant.perPeriod);
    const balance = grant.perPeriod - monthlyGrantUsed;

    res.status(200).json({
      balance,
      monthlyGrant: grant.perPeriod,
      monthlyGrantUsed,
      nextRefreshAt: subscription.currentPeriodEnd.toISOString(),
      periodLabel: MONTH_LABEL_FORMATTER.format(
        subscription.currentPeriodStart,
      ),
    });
    return;
  } catch (error) {
    req.log.error(
      {
        error,
        stack: error instanceof Error ? error.stack : undefined,
        accountId,
      },
      "Failed to compute credits balance",
    );
    res.status(500).json({ error: "Failed to compute credits balance" });
    return;
  }
}
