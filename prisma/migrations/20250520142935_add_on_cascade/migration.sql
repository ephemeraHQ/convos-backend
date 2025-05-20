-- DropForeignKey
ALTER TABLE "ConversationMetadata" DROP CONSTRAINT "ConversationMetadata_deviceIdentityId_fkey";

-- DropForeignKey
ALTER TABLE "Device" DROP CONSTRAINT "Device_userId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceIdentity" DROP CONSTRAINT "DeviceIdentity_userId_fkey";

-- DropForeignKey
ALTER TABLE "IdentitiesOnDevice" DROP CONSTRAINT "IdentitiesOnDevice_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "IdentitiesOnDevice" DROP CONSTRAINT "IdentitiesOnDevice_identityId_fkey";

-- DropForeignKey
ALTER TABLE "Profile" DROP CONSTRAINT "Profile_deviceIdentityId_fkey";

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceIdentity" ADD CONSTRAINT "DeviceIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentitiesOnDevice" ADD CONSTRAINT "IdentitiesOnDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentitiesOnDevice" ADD CONSTRAINT "IdentitiesOnDevice_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "DeviceIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_deviceIdentityId_fkey" FOREIGN KEY ("deviceIdentityId") REFERENCES "DeviceIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMetadata" ADD CONSTRAINT "ConversationMetadata_deviceIdentityId_fkey" FOREIGN KEY ("deviceIdentityId") REFERENCES "DeviceIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
