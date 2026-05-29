-- Stack 2 / T10: NotificationSubscriptionSnapshot + ClientIdentifier.accountId
--
-- Adds the snapshot table that persists the last desired push topic set per
-- ClientIdentifier (used by /v2/notifications/subscribe's idempotency check
-- and by the new /v2/notifications/debug/status endpoint). Also adds the
-- accountId column to ClientIdentifier so the webhook handler can refuse
-- cross-account push delivery (Stack 2 D15).

-- AlterTable: add accountId to ClientIdentifier
ALTER TABLE "ClientIdentifier" ADD COLUMN "accountId" UUID;

-- Backfill ClientIdentifier.accountId from the joined DeviceRegistration row.
-- Rows where DeviceRegistration.accountId is NULL stay NULL; the webhook
-- handler will treat them as untrusted ghosts and refuse to send.
UPDATE "ClientIdentifier" ci
SET "accountId" = dr."accountId"
FROM "DeviceRegistration" dr
WHERE ci."deviceId" = dr."deviceId"
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
-- (sign-out, NSE unregister cleanup, T20 orphan migration, etc.)
ALTER TABLE "NotificationSubscriptionSnapshot" ADD CONSTRAINT "NotificationSubscriptionSnapshot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ClientIdentifier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
