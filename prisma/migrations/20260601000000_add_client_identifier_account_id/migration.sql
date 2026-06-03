-- Add ClientIdentifier.accountId for the webhook delivery account check.
--
-- The webhook handler refuses push delivery when client.accountId does not
-- match the joined DeviceRegistration.accountId. A device can have many
-- historical ClientIdentifier rows (one per account that ever signed in on
-- the device); without the account check, an orphan from a previous account
-- can still trigger pushes that wake the current account's device.

-- AlterTable: add accountId to ClientIdentifier
ALTER TABLE "ClientIdentifier" ADD COLUMN "accountId" UUID;

-- Backfill ClientIdentifier.accountId for the most recent row per deviceId.
-- Stamping all historical rows with the device's current accountId would
-- let stale rows from previous accounts pass the webhook delivery guard
-- (client.accountId == device.accountId) instead of being treated as
-- untrusted ghosts. Older rows stay NULL until a fresh subscribe rewrites
-- the correct account on the live row; the orphan ClientIdentifier cleanup
-- migration handles long-tail churn separately. Rows where
-- DeviceRegistration.accountId is NULL also stay NULL.
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
