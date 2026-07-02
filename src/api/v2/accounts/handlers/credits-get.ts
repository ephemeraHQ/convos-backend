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
 * Single-ledger model: `balance` is always the one wallet
 * (`UserCredits.balance`), for subscribers and non-subscribers alike. The
 * display fields differ only in framing:
 *   - With an entitled Subscription (effective status in trial/active/grace/
 *     billingRetry per `isEntitledSubscription`): `monthlyGrant` = the period
 *     allotment from tier × period config (the `sub_grant` we wrote on
 *     subscribe/renewal); `monthlyGrantUsed = min(periodConsumes, monthlyGrant)`
 *     where `periodConsumes` is |consume deltas| since `currentPeriodStart`.
 *     We compute usage from period consumes (NOT `monthlyGrant − balance`)
 *     because the wallet is commingled — admin/promo/signup credits sharing it
 *     would otherwise make `monthlyGrant − balance` negative and hide real
 *     usage. `nextRefreshAt = currentPeriodEnd`; `periodLabel` = the month
 *     label.
 *   - Without an entitled Subscription (no row, expired, revoked, or grace
 *     past end): free-tier daily-refill semantics. `monthlyGrant` =
 *     `PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS`; `monthlyGrantUsed` =
 *     `max(0, cap − balance)`; `nextRefreshAt` = start of next UTC day;
 *     `periodLabel` = "Daily".
 *
 * Note for v1: field names reuse `monthlyGrant`/`monthlyGrantUsed` for the
 * daily cap so iOS doesn't need a client-side change. Proper `dailyCap` /
 * `dailyUsed` fields are a follow-up requiring iOS coordination.
 */
export async function creditsGetHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId as string;

  try {
    const subscription = await findCurrentByAccountId(accountId);
    const balance = await getBalance(accountId);
    const positiveBalance = balance < 0n ? 0n : balance;
    const balanceCredits = Number(positiveBalance);

    if (!subscription || !isEntitledSubscription(subscription)) {
      const cap = config.freeTierDailyCapCredits;
      const used = Math.max(0, cap - balanceCredits);
      const now = new Date();
      res.status(200).json({
        balance: balanceCredits,
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
    // Usage = period consumes (capped at the allotment), NOT
    // `monthlyGrant − balance`. The wallet is commingled, so admin/promo/signup
    // credits would otherwise push `monthlyGrant − balance` negative and report
    // 0 used despite real spend. `perPeriod=0` → min clamps to 0.
    const monthlyGrantUsed = Math.min(
      await sumPeriodConsumes(accountId, subscription.currentPeriodStart),
      grant.perPeriod,
    );

    res.status(200).json({
      balance: balanceCredits,
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
