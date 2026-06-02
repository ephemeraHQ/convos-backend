/**
 * Subscription tier identifiers stored in the `Subscription.tier` text
 * column. Single source of truth for valid tier values now that the
 * Postgres `SubscriptionTier` enum has been dropped.
 *
 * iOS reads the same string and translates it to its own
 * `SubscriptionTier` enum case. Keep the wire-format values aligned.
 */
export const SUBSCRIPTION_TIER_PLUS = "plus";

export const SUBSCRIPTION_TIERS = [SUBSCRIPTION_TIER_PLUS] as const;

export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export const isSubscriptionTier = (value: string): value is SubscriptionTier =>
  (SUBSCRIPTION_TIERS as readonly string[]).includes(value);

/**
 * Narrow a raw string (e.g. `Subscription.tier` straight from Prisma) to
 * a typed `SubscriptionTier`. Throws if the value is not one of the
 * known tiers — anything else in the DB is a backfill/migration bug
 * that the application can't reason about.
 */
export const requireSubscriptionTier = (value: string): SubscriptionTier => {
  if (!isSubscriptionTier(value)) {
    throw new Error(
      `Unknown subscription tier in DB: "${value}". Expected one of: ${SUBSCRIPTION_TIERS.join(", ")}`,
    );
  }
  return value;
};
