-- Drop the SubscriptionTier Postgres enum in favor of a plain text
-- column. The enum carried `builder` and `pro` values that were the
-- internal DB names for what iOS displays as "Plus" — the asymmetry
-- forced an iOS-side decoder that mapped the legacy strings to .plus.
--
-- After this migration:
--   - `Subscription.tier` is a TEXT column.
--   - All existing rows are backfilled from `builder`/`pro` -> `plus`.
--   - The Postgres enum type is dropped.
--   - The application defines the valid tier set in TypeScript
--     (src/subscriptions/tiers.ts) and validates writes there.
--
-- All three statements run in a single transaction. Postgres allows
-- DROP TYPE on an enum once no column references it, and the
-- preceding ALTER TABLE removes the only reference. Same-transaction
-- ordering is safe because the type isn't referenced after the
-- ALTER TABLE.

ALTER TABLE "Subscription"
  ALTER COLUMN "tier" TYPE TEXT USING tier::TEXT;

UPDATE "Subscription"
SET "tier" = 'plus'
WHERE "tier" IN ('builder', 'pro');

DROP TYPE "SubscriptionTier";
