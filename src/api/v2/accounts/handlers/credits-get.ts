import type { Request, Response } from "express";
import { getBalance } from "@/payments";
import { config } from "@/payments/credits/config";
import { startOfNextUtcDay } from "@/payments/daily-refill/utc";
import { sumPeriodConsumes } from "@/payments/spendable";
import { findCurrentByAccountId } from "@/subscriptions/repository";
import { isEntitledSubscriptionForDisplay } from "@/subscriptions/status";
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
 *   - With an entitled Subscription (display-effective status in trial/active/
 *     grace/billingRetry per `isEntitledSubscriptionForDisplay` — which keeps
 *     an auto-renewing sub entitled while a late/dropped renewal webhook leaves
 *     its `currentPeriodEnd` in the recent past): `monthlyGrant` = the period
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
 *   - When the daily refill is DISABLED (cap = 0, the config kill-switch): do
 *     not promise a refresh that will not come. The response mirrors the iOS
 *     app's own design-approved free-state fixture —
 *     `CreditsStatePreset.noSubNoTrial` (ConvosCore/Services/Credits/
 *     CreditsStatePreset.swift): `monthlyGrant`/`Used` = 0, `nextRefreshAt` =
 *     now, `periodLabel` = REFILL_DISABLED_PERIOD_LABEL ("—"). See the
 *     constant below for why every key must stay present.
 *
 * Note for v1: field names reuse `monthlyGrant`/`monthlyGrantUsed` for the
 * daily cap so iOS doesn't need a client-side change. Proper `dailyCap` /
 * `dailyUsed` fields are a follow-up requiring iOS coordination.
 */

/**
 * `periodLabel` when the daily refill is disabled — the exact label the iOS
 * design fixture uses for the "no sub / no trial" state.
 *
 * Shipped-client constraints (all verified against convos-ios origin/dev):
 * - `CreditBalance.nextRefreshAt` is a NON-OPTIONAL `Date`
 *   (ConvosCore/Storage/Models/CreditBalance.swift:7): omitting the key or
 *   sending null makes Codable throw and breaks the whole credits fetch for
 *   every installed build, so the key must stay present and parseable.
 * - The only user-facing renders of these fields are on
 *   SubscriptionSettingsView: "\(balance) / \(monthlyGrant)" and
 *   "Refreshes \(mediumDate(nextRefreshAt))", shown whenever a balance
 *   exists — there is no data-driven hide condition, so we cannot suppress
 *   the footer; we can only choose the least-wrong date.
 * - `periodLabel` and `monthlyGrantUsed` render in the debug menu only;
 *   `fractionRemaining`/`isLow` have no shipped consumers, and grant = 0 is
 *   guarded in the model (`guard monthlyGrant > 0 else nil`) — no NaN risk.
 *
 * Emitting `{ monthlyGrant: 0, monthlyGrantUsed: 0, nextRefreshAt: now,
 * periodLabel: "—" }` therefore reproduces `CreditsStatePreset.noSubNoTrial`
 * exactly — the canned state designers/QA already dogfooded and signed off —
 * rather than inventing a new one. The footer reads "Refreshes <today>",
 * which is the least-wrong string the shipped format can produce: unlike
 * tomorrow's date it makes no forward promise, and unlike a far-future
 * sentinel it doesn't render an absurd year. No iOS update is required.
 */
export const REFILL_DISABLED_PERIOD_LABEL = "—";
export async function creditsGetHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId as string;

  try {
    const subscription = await findCurrentByAccountId(accountId);
    const balance = await getBalance(accountId);
    const positiveBalance = balance < 0n ? 0n : balance;
    const balanceCredits = Number(positiveBalance);

    if (!subscription || !isEntitledSubscriptionForDisplay(subscription)) {
      const cap = config.freeTierDailyCapCredits;
      // cap = 0 → the refill kill-switch is on; there is no daily grant and no
      // refresh coming, so advertise neither (used clamps to 0 with cap 0) and
      // emit the iOS design fixture's free-state combo instead — see
      // REFILL_DISABLED_PERIOD_LABEL for the shipped-client rendering analysis.
      const refillEnabled = cap > 0;
      const used = Math.max(0, cap - balanceCredits);
      const now = new Date();
      res.status(200).json({
        balance: balanceCredits,
        monthlyGrant: cap,
        monthlyGrantUsed: used,
        nextRefreshAt: refillEnabled
          ? startOfNextUtcDay(now).toISOString()
          : now.toISOString(),
        periodLabel: refillEnabled ? "Daily" : REFILL_DISABLED_PERIOD_LABEL,
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
