-- AlterTable: Make pushToken nullable
ALTER TABLE "DeviceRegistration" ALTER COLUMN "pushToken" DROP NOT NULL;

-- Update any empty strings to NULL (clean up existing data)
UPDATE "DeviceRegistration" SET "pushToken" = NULL WHERE "pushToken" = '';

-- CreateIndex: Add unique constraint on push token combination
CREATE UNIQUE INDEX "DeviceRegistration_pushTokenType_apnsEnv_pushToken_key" ON "DeviceRegistration"("pushTokenType", "apnsEnv", "pushToken");
