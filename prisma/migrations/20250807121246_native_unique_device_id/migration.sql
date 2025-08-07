/*
  Warnings:

  - You are about to drop the column `deviceId` on the `Device` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Device_deviceId_key";

-- AlterTable
ALTER TABLE "Device" DROP COLUMN "deviceId";
