/* Query to find DeviceIdentity records that should be deleted */
SELECT
    di.id AS "DeviceIdentity_ID_to_Delete",
    di."userId",
    di."xmtpId",
    di."turnkeyAddress",
    di."createdAt"
FROM
    "DeviceIdentity" di
WHERE
    -- Condition A: This DeviceIdentity has no associated profile
    NOT EXISTS (
        SELECT 1
        FROM "Profile" p
        WHERE p."deviceIdentityId" = di.id
    )
    -- Condition B: There EXISTS another DeviceIdentity for the same userId and xmtpId
    -- that DOES have an associated profile.
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
    );

/*
  Warnings:

  - A unique constraint covering the columns `[userId,xmtpId]` on the table `DeviceIdentity` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "DeviceIdentity_userId_xmtpId_key" ON "DeviceIdentity"("userId", "xmtpId");
