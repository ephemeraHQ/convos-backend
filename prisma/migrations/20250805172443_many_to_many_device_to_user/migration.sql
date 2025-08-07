/*
  Warnings:

  - You are about to drop the column `userId` on the `Device` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Device" DROP CONSTRAINT "Device_userId_fkey";

-- AlterTable
ALTER TABLE "Device" DROP COLUMN "userId";

-- CreateTable
CREATE TABLE "UsersOnDevice" (
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsersOnDevice_pkey" PRIMARY KEY ("userId","deviceId")
);

-- AddForeignKey
ALTER TABLE "UsersOnDevice" ADD CONSTRAINT "UsersOnDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsersOnDevice" ADD CONSTRAINT "UsersOnDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
