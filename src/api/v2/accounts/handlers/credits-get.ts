import type { Request, Response } from "express";
import { getBalance } from "@/payments";
import { config } from "@/payments/credits/config";
import { startOfNextUtcDay } from "@/payments/daily-refill/utc";
import { sumPeriodConsumes } from "@/payments/spendable";
import { findCurrentByAccountId } from "@/subscriptions/repository";
import { isEntitledSubscription } from "@/subscriptions/status";
import { tierGrant } from "@/subscriptions/tier-config";
import { requireSubscriptionTier } from "@/subscriptions/tiers";

const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * GET /v2/accounts/me/credits — returns the iOS `CreditBalance` shape:
 * `{ balance, monthlyGrant, monthlyGrantUsed, nextRefreshAt, periodLabel }`.
 *
 * Derivation:
 *   - With an entitled Subscription (effective status in trial/active/grace/
 *     billingRetry per `isEntitledSubscription`): `monthlyGrant` from tier ×
 *     period config; `monthlyGrantUsed` = sum of consume-ledger deltas since
 *     `currentPeriodStart`; `balance = monthlyGrant - monthlyGrantUsed`;
 *     `nextRefreshAt = currentPeriodEnd`.
 *   - Without an entitled Subscription (no row, expired, revoked, or grace
 *     past end): free-tier daily-refill semantics. `balance` = live ledger
 *     balance clamped to 0; `monthlyGrant` = `PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS`;
 *     `monthlyGrantUsed` = `max(0, cap - balance)`; `nextRefreshAt` = start
 *     of next UTC day; `periodLabel` = "Daily".
 *
 * Note for v1: field names reuse `monthlyGrant`/`monthlyGrantUsed` for the
 * daily cap so iOS doesn't need a client-side change. Proper `dailyCap` /
 * `dailyUsed` fields are a follow-up requiring iOS coordination.
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

    const grant = tierGrant(
      requireSubscriptionTier(subscription.tier),
      subscription.period,
    );
    const rawUsed = await sumPeriodConsumes(
      accountId,
      subscription.currentPeriodStart,
    );
    const monthlyGrantUsed = Math.min(rawUsed, grant.perPeriod);
    // Spendable balance = derived subscription allotment + any raw
    // (admin/promo/signup) credits. The buckets are disjoint, so this can't
    // double-count; raw is clamped to >= 0 so it never reduces the allotment.
    // `monthlyGrant`/`monthlyGrantUsed`/`periodLabel` stay derived-only to keep
    // the iOS contract byte-identical.
    //
    // N-N1: compute the sum in BigInt to mirror `getSpendableBalance`
    // (`BigInt(remaining) + (raw > 0n ? raw : 0n)`) exactly — the two read
    // paths must not diverge on numeric type. Down-cast to Number only at the
    // JSON boundary (the iOS `CreditBalance` contract is a number, and the
    // value is well under 2^53).
    const rawBalance = await getBalance(accountId);
    const positiveRaw = rawBalance > 0n ? rawBalance : 0n;
    const derivedRemaining = BigInt(grant.perPeriod - monthlyGrantUsed);
    const balance = Number(derivedRemaining + positiveRaw);

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
