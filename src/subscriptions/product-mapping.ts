import { SubscriptionPeriod, SubscriptionTier } from "@prisma/client";
import { AppError } from "@/utils/errors";

export type ProductMapping = {
  tier: SubscriptionTier;
  period: SubscriptionPeriod;
};

// Matches "app.convos.subs.<tier>.<period>" where tier is builder|pro and
// period is monthly|annual. Anchored so trailing junk fails fast.
const PRODUCT_ID_PATTERN =
  /^app\.convos\.subs\.(builder|pro)\.(monthly|annual)$/;

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
      `Unrecognized productId: "${productId}". Expected app.convos.subs.<builder|pro>.<monthly|annual>`,
    );
  }
  const [, tierRaw, periodRaw] = match;
  return {
    tier:
      tierRaw === "builder" ? SubscriptionTier.builder : SubscriptionTier.pro,
    period:
      periodRaw === "monthly"
        ? SubscriptionPeriod.monthly
        : SubscriptionPeriod.annual,
  };
};
