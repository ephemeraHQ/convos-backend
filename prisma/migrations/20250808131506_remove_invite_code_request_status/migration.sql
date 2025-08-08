/*
  Warnings:

  - You are about to drop the column `status` on the `InviteCodeRequest` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "InviteCodeRequest_status_idx";

-- AlterTable
ALTER TABLE "InviteCodeRequest" DROP COLUMN "status";
