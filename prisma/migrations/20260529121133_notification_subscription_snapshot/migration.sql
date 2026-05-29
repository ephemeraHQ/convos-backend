-- NotificationSubscriptionSnapshot + ClientIdentifier.accountId
--
-- Adds the snapshot table that persists the last desired push topic set per
-- ClientIdentifier (used by /v2/notifications/subscribe's idempotency check
-- and by the /v2/notifications/debug/status endpoint). Also adds the
-- accountId column to ClientIdentifier so the webhook handler can refuse
-- cross-account push delivery.

-- AlterTable: add accountId to ClientIdentifier
ALTER TABLE "ClientIdentifier" ADD COLUMN "accountId" UUID;

-- Backfill ClientIdentifier.accountId for the most recent row per deviceId.
-- A device can have many historical ClientIdentifier rows (one per account
-- that ever signed in on the device). Stamping all of them with the device's
-- current accountId would let stale rows from previous accounts pass the
-- webhook delivery guard (client.accountId == device.accountId) instead of
-- being treated as untrusted ghosts. Older rows stay NULL until a fresh
-- subscribe rewrites the correct account on the live row; the orphan
-- ClientIdentifier cleanup migration handles long-tail churn separately.
-- Rows where DeviceRegistration.accountId is NULL also stay NULL.
WITH latest_client_per_device AS (
    SELECT DISTINCT ON ("deviceId") "id", "deviceId"
    FROM "ClientIdentifier"
    ORDER BY "deviceId", "updatedAt" DESC, "addedAt" DESC, "id"
)
UPDATE "ClientIdentifier" ci
SET "accountId" = dr."accountId"
FROM "DeviceRegistration" dr,
     latest_client_per_device lcpd
WHERE ci."id" = lcpd."id"
  AND ci."deviceId" = dr."deviceId"
  AND dr."accountId" IS NOT NULL;

CREATE INDEX "ClientIdentifier_accountId_idx" ON "ClientIdentifier"("accountId");

-- CreateTable: NotificationSubscriptionSnapshot
CREATE TABLE "NotificationSubscriptionSnapshot" (
    "clientId" TEXT NOT NULL,
    "accountId" UUID,
    "topicCount" INTEGER NOT NULL,
    "topicHash" VARCHAR(64) NOT NULL,
    "kindSummary" JSONB,
    "lastContext" TEXT,
    "lastSubscribeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRemoteApplySucceeded" BOOLEAN NOT NULL,
    "lastRemoteApplyError" TEXT,
    "pushTokenSha256AtApply" VARCHAR(64) NOT NULL,
    "apnsEnvAtApply" "ApnsEnvironment",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationSubscriptionSnapshot_pkey" PRIMARY KEY ("clientId")
);

CREATE INDEX "NotificationSubscriptionSnapshot_accountId_idx" ON "NotificationSubscriptionSnapshot"("accountId");

CREATE INDEX "NotificationSubscriptionSnapshot_updatedAt_idx" ON "NotificationSubscriptionSnapshot"("updatedAt");

-- AddForeignKey: cascade delete when the parent ClientIdentifier is removed
-- (sign-out, NSE unregister cleanup, orphan cleanup migration, etc.)
ALTER TABLE "NotificationSubscriptionSnapshot" ADD CONSTRAINT "NotificationSubscriptionSnapshot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ClientIdentifier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
