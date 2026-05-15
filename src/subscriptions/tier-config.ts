import { SubscriptionPeriod, SubscriptionTier } from "@prisma/client";
import { AppError } from "@/utils/errors";

const parsePositiveInt = (key: string, raw: string | undefined): number => {
  if (!raw) {
    throw new AppError(500, `${key} is not configured`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new AppError(500, `${key} must be a positive integer, got: "${raw}"`);
  }
  return n;
};

/**
 * Per-tier monthly credit allotment, env-driven.
 *
 * These values are the source of truth for `monthlyGrant` in the iOS
 * `CreditBalance` model. They do NOT write to the ledger — subscription
 * allotments are derived (Subscription row + this config) at read time.
 *
 * Annual subscriptions inherit the monthly amount per period; the renewal
 * cycle is just 12× longer. iOS displays `monthlyGrant` either way; the
 * `period` field distinguishes the billing cadence.
 */
const monthlyAmountForTier = (tier: SubscriptionTier): number => {
  switch (tier) {
    case SubscriptionTier.builder:
      return parsePositiveInt(
        "PAYMENTS_GRANT_BUILDER_MONTHLY",
        process.env.PAYMENTS_GRANT_BUILDER_MONTHLY,
      );
    case SubscriptionTier.pro:
      return parsePositiveInt(
        "PAYMENTS_GRANT_PRO_MONTHLY",
        process.env.PAYMENTS_GRANT_PRO_MONTHLY,
      );
  }
};

export type TierGrant = {
  tier: SubscriptionTier;
  period: SubscriptionPeriod;
  /** Credits granted per billing period (monthly or annual, depending). */
  perPeriod: number;
};

/**
 * Compute the credit allotment for a tier × period. Annual subscriptions
 * grant 12 × the monthly amount once per renewal (not 12 separate monthly
 * resets — the user gets a year's worth up front and burns down across the
 * year). Monthly subscriptions reset to the monthly amount each renewal.
 */
export const tierGrant = (
  tier: SubscriptionTier,
  period: SubscriptionPeriod,
): TierGrant => {
  const monthly = monthlyAmountForTier(tier);
  return {
    tier,
    period,
    perPeriod: period === SubscriptionPeriod.annual ? monthly * 12 : monthly,
  };
};
