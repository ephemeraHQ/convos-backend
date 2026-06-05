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
//   - "app.convos.subs.(builder|pro).<period>" (LEGACY) — the original
//     two-tier SKUs. Apple bakes the productId into the signed JWS at the
//     original purchase and keeps returning it on every renewal/upgrade for
//     the life of that subscription, so existing subscribers (incl. early
//     TestFlight / App Store testers) still send these. We dropped the
//     Builder/Pro tiers in #263 and backfilled all rows to `plus`; we must
//     keep *recognizing* these IDs or those subscribers' verify 400s forever
//     (CON-386). iOS can't rewrite them client-side — that would break Apple's
//     signature.
// period is always monthly|annual. Anchored so trailing junk fails fast.
//
// We ship a single tier (Plus). Everything matched here — including the legacy
// builder/pro SKUs — decodes to SUBSCRIPTION_TIER_PLUS.
const PRODUCT_ID_PATTERN =
  /^app\.convos\.subs\.(?:(?:builder|pro|plus)\.)?(monthly|annual)$/;

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
      `Unrecognized productId: "${productId}". Expected app.convos.subs[.(builder|pro|plus)].<monthly|annual> — builder/pro are legacy SKUs mapped to plus`,
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
