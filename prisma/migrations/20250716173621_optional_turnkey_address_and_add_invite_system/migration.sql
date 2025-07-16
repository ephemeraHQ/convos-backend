-- Make turnkeyAddress optional
ALTER TABLE "DeviceIdentity" ALTER COLUMN "turnkeyAddress" DROP NOT NULL;

-- Add the new invite code system tables
CREATE TYPE "InviteCodeStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'DISABLED');

CREATE TYPE "InviteCodeRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "InviteCode" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "maxUses" INTEGER,
    "usesCount" INTEGER NOT NULL DEFAULT 0,
    "status" "InviteCodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "groupId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteCodeUse" (
    "id" TEXT NOT NULL,
    "inviteCodeId" TEXT NOT NULL,
    "usedById" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteCodeUse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteCodeRequest" (
    "id" TEXT NOT NULL,
    "inviteCodeId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "status" "InviteCodeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InviteCodeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InviteCode_status_idx" ON "InviteCode"("status");

-- CreateIndex
CREATE INDEX "InviteCode_createdById_idx" ON "InviteCode"("createdById");

-- CreateIndex
CREATE INDEX "InviteCode_groupId_idx" ON "InviteCode"("groupId");

-- CreateIndex
CREATE INDEX "InviteCodeUse_inviteCodeId_idx" ON "InviteCodeUse"("inviteCodeId");

-- CreateIndex
CREATE INDEX "InviteCodeUse_usedById_idx" ON "InviteCodeUse"("usedById");

-- CreateIndex
CREATE INDEX "InviteCodeRequest_inviteCodeId_idx" ON "InviteCodeRequest"("inviteCodeId");

-- CreateIndex
CREATE INDEX "InviteCodeRequest_requesterId_idx" ON "InviteCodeRequest"("requesterId");

-- CreateIndex
CREATE INDEX "InviteCodeRequest_status_idx" ON "InviteCodeRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCodeUse_inviteCodeId_usedById_key" ON "InviteCodeUse"("inviteCodeId", "usedById");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCodeRequest_inviteCodeId_requesterId_key" ON "InviteCodeRequest"("inviteCodeId", "requesterId");

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "DeviceIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCodeUse" ADD CONSTRAINT "InviteCodeUse_inviteCodeId_fkey" FOREIGN KEY ("inviteCodeId") REFERENCES "InviteCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCodeUse" ADD CONSTRAINT "InviteCodeUse_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "DeviceIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCodeRequest" ADD CONSTRAINT "InviteCodeRequest_inviteCodeId_fkey" FOREIGN KEY ("inviteCodeId") REFERENCES "InviteCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCodeRequest" ADD CONSTRAINT "InviteCodeRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "DeviceIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
