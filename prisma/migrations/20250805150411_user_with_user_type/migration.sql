
-- CreateEnum
CREATE TYPE "UserType" AS ENUM
('onDevice', 'turnkey');

-- DropIndex
DROP INDEX "User_turnkeyUserId_key";

-- AlterTable
ALTER TABLE "User" RENAME COLUMN "turnkeyUserId" TO "userId";

-- AlterTable
ALTER TABLE "User" ADD COLUMN "userType" "UserType" NOT NULL DEFAULT 'onDevice';

-- CreateIndex
CREATE UNIQUE INDEX "User_userType_userId_key" ON "User"("userType", "userId");
