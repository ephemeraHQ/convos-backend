/*
  Warnings:

  - You are about to drop the column `userId` on the `DeviceIdentity` table. All the data in the column will be lost.
  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UsersOnDevice` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "DeviceIdentity" DROP CONSTRAINT "DeviceIdentity_userId_fkey";

-- DropForeignKey
ALTER TABLE "UsersOnDevice" DROP CONSTRAINT "UsersOnDevice_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "UsersOnDevice" DROP CONSTRAINT "UsersOnDevice_userId_fkey";

-- AlterTable
ALTER TABLE "DeviceIdentity" DROP COLUMN "userId";

-- DropTable
DROP TABLE "User";

-- DropTable
DROP TABLE "UsersOnDevice";

-- DropEnum
DROP TYPE "UserType";
