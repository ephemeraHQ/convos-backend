/*
  Warnings:

  - A unique constraint covering the columns `[xmtpId]` on the table `DeviceIdentity` will be added. If there are existing duplicate values, this will fail.
  - Made the column `xmtpId` on table `DeviceIdentity` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "DeviceIdentity_userId_xmtpId_key";

-- DropIndex
DROP INDEX "DeviceIdentity_xmtpId_idx";

-- AlterTable
ALTER TABLE "DeviceIdentity" ALTER COLUMN "xmtpId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "DeviceIdentity_xmtpId_key" ON "DeviceIdentity"("xmtpId");
