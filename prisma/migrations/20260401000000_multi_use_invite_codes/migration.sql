-- AlterTable: Add new columns to InviteCode
ALTER TABLE "InviteCode" ADD COLUMN "name" VARCHAR(255);
ALTER TABLE "InviteCode" ADD COLUMN "maxRedemptions" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "InviteCode" ADD COLUMN "redemptionCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InviteCode" ADD COLUMN "parentCodeId" UUID;

-- Backfill: set redemptionCount = 1 for already-redeemed codes
UPDATE "InviteCode" SET "redemptionCount" = 1 WHERE "redeemedAt" IS NOT NULL;

-- CreateTable: InviteCodeRedemption
CREATE TABLE "InviteCodeRedemption" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "inviteCodeId" UUID NOT NULL,
    "childCodeId" UUID,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteCodeRedemption_pkey" PRIMARY KEY ("id")
);

-- Backfill: create InviteCodeRedemption rows for already-redeemed codes
INSERT INTO "InviteCodeRedemption" ("id", "inviteCodeId", "redeemedAt")
SELECT gen_random_uuid(), "id", "redeemedAt"
FROM "InviteCode"
WHERE "redeemedAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "InviteCodeRedemption_inviteCodeId_idx" ON "InviteCodeRedemption"("inviteCodeId");

-- CreateIndex
CREATE INDEX "InviteCodeRedemption_childCodeId_idx" ON "InviteCodeRedemption"("childCodeId");

-- CreateIndex
CREATE INDEX "InviteCode_parentCodeId_idx" ON "InviteCode"("parentCodeId");

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_parentCodeId_fkey" FOREIGN KEY ("parentCodeId") REFERENCES "InviteCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCodeRedemption" ADD CONSTRAINT "InviteCodeRedemption_inviteCodeId_fkey" FOREIGN KEY ("inviteCodeId") REFERENCES "InviteCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCodeRedemption" ADD CONSTRAINT "InviteCodeRedemption_childCodeId_fkey" FOREIGN KEY ("childCodeId") REFERENCES "InviteCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
