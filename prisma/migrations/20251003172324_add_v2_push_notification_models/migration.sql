-- CreateTable
CREATE TABLE "DeviceRegistration" (
    "deviceId" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "pushTokenType" "PushTokenType" NOT NULL DEFAULT 'apns',
    "apnsEnv" "ApnsEnvironment",
    "pushFailures" INTEGER NOT NULL DEFAULT 0,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSentAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),

    CONSTRAINT "DeviceRegistration_pkey" PRIMARY KEY ("deviceId")
);

-- CreateTable
CREATE TABLE "ClientIdentifier" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceRegistration_pushToken_idx" ON "DeviceRegistration"("pushToken");

-- CreateIndex
CREATE INDEX "DeviceRegistration_disabled_pushFailures_idx" ON "DeviceRegistration"("disabled", "pushFailures");

-- CreateIndex
CREATE INDEX "ClientIdentifier_deviceId_idx" ON "ClientIdentifier"("deviceId");

-- AddForeignKey
ALTER TABLE "ClientIdentifier" ADD CONSTRAINT "ClientIdentifier_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DeviceRegistration"("deviceId") ON DELETE CASCADE ON UPDATE CASCADE;
