-- CreateEnum
CREATE TYPE "DeviceOS" AS ENUM ('ios', 'android', 'web');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT,
    "os" "DeviceOS" NOT NULL,
    "pushToken" TEXT,
    "expoToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceIdentity" (
    "id" TEXT NOT NULL,
    "xmtpId" TEXT NOT NULL,
    "privyAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentitiesOnDevice" (
    "deviceId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,

    CONSTRAINT "IdentitiesOnDevice_pkey" PRIMARY KEY ("deviceId","identityId")
);

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "deviceIdentityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMetadata" (
    "id" TEXT NOT NULL,
    "deviceIdentityId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "readUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Profile_deviceIdentityId_key" ON "Profile"("deviceIdentityId");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentitiesOnDevice" ADD CONSTRAINT "IdentitiesOnDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentitiesOnDevice" ADD CONSTRAINT "IdentitiesOnDevice_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "DeviceIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_deviceIdentityId_fkey" FOREIGN KEY ("deviceIdentityId") REFERENCES "DeviceIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMetadata" ADD CONSTRAINT "ConversationMetadata_deviceIdentityId_fkey" FOREIGN KEY ("deviceIdentityId") REFERENCES "DeviceIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
