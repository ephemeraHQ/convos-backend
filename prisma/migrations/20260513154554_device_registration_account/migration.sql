-- AlterTable
ALTER TABLE "DeviceRegistration" ADD COLUMN "accountId" UUID;

-- CreateIndex
CREATE INDEX "DeviceRegistration_accountId_idx" ON "DeviceRegistration"("accountId");

-- AddForeignKey
ALTER TABLE "DeviceRegistration" ADD CONSTRAINT "DeviceRegistration_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
