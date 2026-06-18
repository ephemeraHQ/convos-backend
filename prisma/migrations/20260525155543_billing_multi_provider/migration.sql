-- Multi-provider billing: introduce BillingProvider enum, generalize the
-- Subscription model to carry per-provider identifiers, and rename
-- AppleReceipt -> BillingReceipt. Existing Apple data is backfilled with
-- provider='apple'; new Google fields are nullable.

-- 1. New enum
CREATE TYPE "BillingProvider" AS ENUM ('apple', 'googlePlay');

-- 2. Subscription: add new columns, backfill provider='apple', then drop the
--    default so future inserts must specify a provider.
ALTER TABLE "Subscription"
    ADD COLUMN "provider" "BillingProvider" NOT NULL DEFAULT 'apple',
    ADD COLUMN "purchaseToken" TEXT,
    ADD COLUMN "linkedPurchaseToken" TEXT,
    ADD COLUMN "obfuscatedAccountId" TEXT;

ALTER TABLE "Subscription" ALTER COLUMN "provider" DROP DEFAULT;

-- 3. Apple-only columns become nullable (Google rows leave them NULL).
ALTER TABLE "Subscription" ALTER COLUMN "originalTransactionId" DROP NOT NULL;
ALTER TABLE "Subscription" ALTER COLUMN "appAccountToken"       DROP NOT NULL;
ALTER TABLE "Subscription" ALTER COLUMN "environment"           DROP NOT NULL;

-- 4. Swap single-column uniques for composite uniques scoped to provider.
--    Postgres treats NULLs as distinct in unique indexes, so per-provider
--    uniqueness falls out naturally without partial indexes.
DROP INDEX "Subscription_originalTransactionId_key";
DROP INDEX "Subscription_appAccountToken_key";

CREATE UNIQUE INDEX "subscription_apple_otx_unique"
    ON "Subscription"("provider", "originalTransactionId");
CREATE UNIQUE INDEX "subscription_apple_aat_unique"
    ON "Subscription"("provider", "appAccountToken");
CREATE UNIQUE INDEX "subscription_play_token_unique"
    ON "Subscription"("provider", "purchaseToken");
CREATE UNIQUE INDEX "subscription_play_oid_unique"
    ON "Subscription"("provider", "obfuscatedAccountId");

CREATE INDEX "Subscription_accountId_provider_idx"
    ON "Subscription"("accountId", "provider");

-- 5. Rename AppleReceipt -> BillingReceipt and repurpose the
--    notificationUUID column as a generic external-notification id.
ALTER TABLE "AppleReceipt" RENAME TO "BillingReceipt";
ALTER TABLE "BillingReceipt" RENAME COLUMN "notificationUUID" TO "externalNotificationId";

ALTER TABLE "BillingReceipt"
    ADD COLUMN "provider" "BillingProvider" NOT NULL DEFAULT 'apple';
ALTER TABLE "BillingReceipt" ALTER COLUMN "provider" DROP DEFAULT;

-- 6. Rename existing indexes/constraints to match the new model name.
ALTER INDEX "AppleReceipt_pkey"                          RENAME TO "BillingReceipt_pkey";
ALTER INDEX "AppleReceipt_idempotencyKey_key"            RENAME TO "BillingReceipt_idempotencyKey_key";
ALTER INDEX "AppleReceipt_notificationUUID_key"          RENAME TO "BillingReceipt_externalNotificationId_key";
ALTER INDEX "AppleReceipt_transactionId_idx"             RENAME TO "BillingReceipt_transactionId_idx";
ALTER INDEX "AppleReceipt_subscriptionId_receivedAt_idx" RENAME TO "BillingReceipt_subscriptionId_receivedAt_idx";

ALTER TABLE "BillingReceipt"
    RENAME CONSTRAINT "AppleReceipt_subscriptionId_fkey" TO "BillingReceipt_subscriptionId_fkey";

CREATE INDEX "BillingReceipt_provider_transactionId_idx"
    ON "BillingReceipt"("provider", "transactionId");
