/*
  Warnings:

  - The values [expo] on the enum `PushTokenType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `expoToken` on the `Device` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[deviceId]` on the table `Device` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `deviceId` to the `Device` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "PushTokenType_new" AS ENUM ('apns', 'fcm');
ALTER TABLE "Device" ALTER COLUMN "pushTokenType" DROP DEFAULT;
ALTER TABLE "Device" ALTER COLUMN "pushTokenType" TYPE "PushTokenType_new" USING ("pushTokenType"::text::"PushTokenType_new");
ALTER TYPE "PushTokenType" RENAME TO "PushTokenType_old";
ALTER TYPE "PushTokenType_new" RENAME TO "PushTokenType";
DROP TYPE "PushTokenType_old";
ALTER TABLE "Device" ALTER COLUMN "pushTokenType" SET DEFAULT 'apns';
COMMIT;

-- AlterTable
ALTER TABLE "Device" DROP COLUMN "expoToken",
ADD COLUMN     "deviceId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Device_deviceId_key" ON "Device"("deviceId");
