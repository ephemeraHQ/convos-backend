import { LedgerReason } from "@prisma/client";
import type { Request, Response } from "express";
import { findCurrentByAccountId } from "@/subscriptions/repository";
import { tierGrant } from "@/subscriptions/tier-config";
import { prisma } from "@/utils/prisma";

const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
});

const startOfNextMonth = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

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
 *   - With an active Subscription: `monthlyGrant` comes from the tier × period
 *     config; `monthlyGrantUsed` is the sum of consume-ledger deltas since
 *     `currentPeriodStart`; `balance = monthlyGrant - monthlyGrantUsed`;
 *     `nextRefreshAt = currentPeriodEnd`.
 *   - Without a Subscription: all credit fields are 0, `nextRefreshAt` is the
 *     start of next calendar month, `periodLabel` is the current month.
 *     iOS will render this as "no plan / paywall".
 *
 * Note for v1: additive grants (NUX trial, top-ups, manual ops) are NOT
 * folded into the balance display yet. The iOS `CreditBalance` model doesn't
 * yet expose a separate "bonus credits" field. When that surface ships,
 * widen this handler to include them.
 */
export async function creditsGetHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId as string;

  try {
    const subscription = await findCurrentByAccountId(accountId);

    if (!subscription) {
      const now = new Date();
      res.status(200).json({
        balance: 0,
        monthlyGrant: 0,
        monthlyGrantUsed: 0,
        nextRefreshAt: startOfNextMonth(now).toISOString(),
        periodLabel: MONTH_LABEL_FORMATTER.format(now),
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
