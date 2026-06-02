import { SubscriptionPeriod } from "@prisma/client";
import {
  SUBSCRIPTION_TIER_PLUS,
  type SubscriptionTier,
} from "@/subscriptions/tiers";
import { AppError } from "@/utils/errors";

export type ProductMapping = {
  tier: SubscriptionTier;
  period: SubscriptionPeriod;
};

// Matches:
//   - "app.convos.subs.plus.<period>" (prod ASC bundle org.convos.ios)
//   - "app.convos.subs.<period>" (dev/preview ASC bundles — unprefixed,
//     locked in because ASC product IDs are globally unique per
//     developer account and prod claimed the `plus.*` ID)
// period is always monthly|annual. Anchored so trailing junk fails fast.
//
// We ship a single tier (Plus). Everything matched here decodes to
// SUBSCRIPTION_TIER_PLUS.
const PRODUCT_ID_PATTERN = /^app\.convos\.subs\.(?:plus\.)?(monthly|annual)$/;

/**
 * Decode a StoreKit product identifier into its tier + period.
 *
 * Throws when the product ID doesn't match our naming scheme — that's a sign
 * the client sent a SKU we never configured, or that the App Store Connect
 * product table drifted from the backend. Either case is a hard error: we
 * cannot guess the grant amount for an unknown tier.
 */
export const productMapping = (productId: string): ProductMapping => {
  const match = PRODUCT_ID_PATTERN.exec(productId);
  if (!match) {
    throw new AppError(
      400,
      `Unrecognized productId: "${productId}". Expected app.convos.subs.<monthly|annual> (dev) or app.convos.subs.plus.<monthly|annual> (prod)`,
    );
  }
  const [, periodRaw] = match;
  return {
    tier: SUBSCRIPTION_TIER_PLUS,
    period:
      periodRaw === "monthly"
        ? SubscriptionPeriod.monthly
        : SubscriptionPeriod.annual,
  };
};
