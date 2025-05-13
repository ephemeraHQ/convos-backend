/*
  Warnings:

  - A unique constraint covering the columns `[xmtpInstallationId]` on the table `IdentitiesOnDevice` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "IdentitiesOnDevice" ADD COLUMN     "xmtpInstallationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "IdentitiesOnDevice_xmtpInstallationId_key" ON "IdentitiesOnDevice"("xmtpInstallationId");
