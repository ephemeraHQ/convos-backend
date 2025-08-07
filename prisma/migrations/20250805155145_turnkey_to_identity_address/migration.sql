/*
  Warnings:

  - You are about to drop the column `turnkeyAddress` on the `DeviceIdentity` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "DeviceIdentity" RENAME COLUMN "turnkeyAddress" TO "identityAddress";

