-- CreateEnum
CREATE TYPE "PushTokenType" AS ENUM ('apns', 'expo', 'fcm');

-- CreateEnum
CREATE TYPE "ApnsEnvironment" AS ENUM ('sandbox', 'production');

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "apnsEnv" "ApnsEnvironment",
ADD COLUMN     "lastPushSuccessAt" TIMESTAMP(3),
ADD COLUMN     "pushFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pushTokenType" "PushTokenType";

-- Set pushTokenType based on existing data
-- If expoToken exists, set to 'expo', otherwise set to 'apns'
UPDATE "Device" SET "pushTokenType" = 
  CASE 
    WHEN "expoToken" IS NOT NULL AND "expoToken" != '' THEN 'expo'::"PushTokenType"
    ELSE 'apns'::"PushTokenType"
  END;

-- Make pushTokenType NOT NULL with default
ALTER TABLE "Device" ALTER COLUMN "pushTokenType" SET NOT NULL,
ALTER COLUMN "pushTokenType" SET DEFAULT 'apns';

-- CreateIndex
CREATE INDEX "Device_pushToken_idx" ON "Device"("pushToken");

-- CreateIndex
CREATE INDEX "Device_pushFailures_idx" ON "Device"("pushFailures");

-- CreateIndex
CREATE INDEX "Device_apnsEnv_idx" ON "Device"("apnsEnv");
