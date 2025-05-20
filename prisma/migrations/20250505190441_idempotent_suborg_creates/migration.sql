/*
 Warnings:
 
 - A unique constraint covering the columns `[credentialId]` on the table `SubOrg` will be added. If there are existing duplicate values, this will fail.
 - Added the required column `credentialId` to the `SubOrg` table without a default value. This is not possible if the table is not empty.
 
 */
--TruncateTable
TRUNCATE TABLE "SubOrg";
-- AlterTable
ALTER TABLE "SubOrg"
ADD COLUMN "credentialId" TEXT NOT NULL;
-- CreateIndex
CREATE UNIQUE INDEX "SubOrg_credentialId_key" ON "SubOrg"("credentialId");
