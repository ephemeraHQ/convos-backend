-- Step 1: Delete referencing rows from DeviceIdentities
WITH device_identities_to_delete AS (
  SELECT id
  from "DeviceIdentity" di
  WHERE NOT EXISTS (
      SELECT 1
      FROM "Profile" p
      WHERE p."deviceIdentityId" = di.id
    )
    AND EXISTS (
      SELECT 1
      FROM "DeviceIdentity" di_valid
        JOIN "Profile" p_valid ON di_valid.id = p_valid."deviceIdentityId"
      WHERE di_valid."userId" = di."userId"
        AND (
          (
            di_valid."xmtpId" IS NULL
            AND di."xmtpId" IS NULL
          )
          OR (di_valid."xmtpId" = di."xmtpId")
        )
    )
),
identities_on_device_deleted AS (
  DELETE FROM "IdentitiesOnDevice"
  WHERE "identityId" IN (
      SELECT id
      FROM device_identities_to_delete
    )
),
profiles_deleted AS (
  DELETE FROM "Profile"
  WHERE "deviceIdentityId" IN (
      SELECT id
      FROM device_identities_to_delete
    )
),
conversation_metadata_deleted AS (
  DELETE FROM "ConversationMetadata"
  WHERE "deviceIdentityId" IN (
      SELECT id
      FROM device_identities_to_delete
    )
)
DELETE FROM "DeviceIdentity"
WHERE id IN (
    SELECT id
    FROM device_identities_to_delete
  );
/*
 Warnings:
 
 - A unique constraint covering the columns `[userId,xmtpId]` on the table `DeviceIdentity` will be added. If there are existing duplicate values, this will fail.
 
 */
-- CreateIndex
CREATE UNIQUE INDEX "DeviceIdentity_userId_xmtpId_key" ON "DeviceIdentity"("userId", "xmtpId");
