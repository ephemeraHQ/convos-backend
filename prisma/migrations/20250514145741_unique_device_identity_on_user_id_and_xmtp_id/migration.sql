-- Step 1: Delete referencing rows from IdentitiesOnDevice
-- that link to the DeviceIdentity records we are about to delete.
DELETE FROM "IdentitiesOnDevice"
WHERE "identityId" IN (
    -- This is the same subquery used to identify the DeviceIdentity records for deletion
    SELECT di.id
    FROM "DeviceIdentity" di
    WHERE
        NOT EXISTS (
            SELECT 1
            FROM "Profile" p
            WHERE p."deviceIdentityId" = di.id
        )
        AND EXISTS (
            SELECT 1
            FROM "DeviceIdentity" di_valid
            JOIN "Profile" p_valid ON di_valid.id = p_valid."deviceIdentityId"
            WHERE
                di_valid."userId" = di."userId"
                AND (
                    (di_valid."xmtpId" IS NULL AND di."xmtpId" IS NULL) OR
                    (di_valid."xmtpId" = di."xmtpId")
                )
        )
);

-- Step 2: Now delete the DeviceIdentity records
-- (Your existing DELETE statement)
DELETE FROM "DeviceIdentity"
WHERE id IN (
    SELECT di.id
    FROM "DeviceIdentity" di
    WHERE
        NOT EXISTS (
            SELECT 1
            FROM "Profile" p
            WHERE p."deviceIdentityId" = di.id
        )
        AND EXISTS (
            SELECT 1
            FROM "DeviceIdentity" di_valid
            JOIN "Profile" p_valid ON di_valid.id = p_valid."deviceIdentityId"
            WHERE
                di_valid."userId" = di."userId"
                AND (
                    (di_valid."xmtpId" IS NULL AND di."xmtpId" IS NULL) OR
                    (di_valid."xmtpId" = di."xmtpId")
                )
        )
);

/*
  Warnings:

  - A unique constraint covering the columns `[userId,xmtpId]` on the table `DeviceIdentity` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "DeviceIdentity_userId_xmtpId_key" ON "DeviceIdentity"("userId", "xmtpId");
