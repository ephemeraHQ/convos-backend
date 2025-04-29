/*
  Warnings:

  - You are about to drop the column `privyAddress` on the `DeviceIdentity` table. All the data in the column will be lost.
  - You are about to drop the column `privyUserId` on the `User` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[turnkeyUserId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `turnkeyAddress` to the `DeviceIdentity` table without a default value. This is not possible if the table is not empty.
  - Added the required column `turnkeyUserId` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "User_privyUserId_key";

-- AlterTable
ALTER TABLE "DeviceIdentity" DROP COLUMN "privyAddress",
ADD COLUMN     "turnkeyAddress" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "privyUserId",
ADD COLUMN     "turnkeyUserId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_turnkeyUserId_key" ON "User"("turnkeyUserId");
