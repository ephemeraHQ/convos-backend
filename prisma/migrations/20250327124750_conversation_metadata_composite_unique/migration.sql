/*
  Warnings:

  - A unique constraint covering the columns `[deviceIdentityId,conversationId]` on the table `ConversationMetadata` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "DeviceOS" ADD VALUE 'macos';

-- DropIndex
DROP INDEX "ConversationMetadata_conversationId_key";

-- CreateIndex
CREATE UNIQUE INDEX "ConversationMetadata_deviceIdentityId_conversationId_key" ON "ConversationMetadata"("deviceIdentityId", "conversationId");
