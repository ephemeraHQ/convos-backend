-- DropForeignKey
ALTER TABLE "InviteCode" DROP CONSTRAINT "InviteCode_groupId_fkey";

-- CreateIndex
CREATE INDEX "InviteCode_status_expiresAt_idx" ON "InviteCode"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "InviteCode_createdById_groupId_idx" ON "InviteCode"("createdById", "groupId");

-- CreateIndex
CREATE INDEX "InviteCodeRequest_inviteCodeId_createdAt_idx" ON "InviteCodeRequest"("inviteCodeId", "createdAt");

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "GroupMetadata"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
