-- CreateTable
CREATE TABLE "InviteCodeNotificationTarget" (
    "id" TEXT NOT NULL,
    "inviteCodeId" TEXT NOT NULL,
    "deviceIdentityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteCodeNotificationTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InviteCodeNotificationTarget_inviteCodeId_idx" ON "InviteCodeNotificationTarget"("inviteCodeId");

-- CreateIndex
CREATE INDEX "InviteCodeNotificationTarget_deviceIdentityId_idx" ON "InviteCodeNotificationTarget"("deviceIdentityId");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCodeNotificationTarget_inviteCodeId_deviceIdentityId_key" ON "InviteCodeNotificationTarget"("inviteCodeId", "deviceIdentityId");

-- AddForeignKey
ALTER TABLE "InviteCodeNotificationTarget" ADD CONSTRAINT "InviteCodeNotificationTarget_inviteCodeId_fkey" FOREIGN KEY ("inviteCodeId") REFERENCES "InviteCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCodeNotificationTarget" ADD CONSTRAINT "InviteCodeNotificationTarget_deviceIdentityId_fkey" FOREIGN KEY ("deviceIdentityId") REFERENCES "DeviceIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
