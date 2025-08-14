/*
  Warnings:

  - You are about to drop the `ConversationMetadata` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "ConversationMetadata" DROP CONSTRAINT "ConversationMetadata_deviceIdentityId_fkey";

-- DropTable
DROP TABLE "ConversationMetadata";
