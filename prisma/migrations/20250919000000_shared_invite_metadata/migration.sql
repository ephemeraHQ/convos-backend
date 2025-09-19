-- CreateTable
CREATE TABLE "GroupMetadata" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupMetadata_pkey" PRIMARY KEY ("id")
);

-- Insert empty metadata entries for all existing groupIds
INSERT INTO "GroupMetadata" ("id", "updatedAt")
SELECT DISTINCT "groupId", CURRENT_TIMESTAMP
FROM "InviteCode"
WHERE "groupId" IS NOT NULL;

-- Remove old metadata fields from InviteCode
ALTER TABLE "InviteCode" DROP COLUMN "name";
ALTER TABLE "InviteCode" DROP COLUMN "description";
ALTER TABLE "InviteCode" DROP COLUMN "imageUrl";

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "GroupMetadata"("id") ON DELETE CASCADE ON UPDATE CASCADE;
