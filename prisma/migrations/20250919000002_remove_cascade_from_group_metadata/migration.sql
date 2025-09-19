-- Remove CASCADE from the foreign key constraint
-- First drop the existing constraint
ALTER TABLE "InviteCode" DROP CONSTRAINT "InviteCode_groupId_fkey";

-- Add the constraint back without CASCADE
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "GroupMetadata"("id");
