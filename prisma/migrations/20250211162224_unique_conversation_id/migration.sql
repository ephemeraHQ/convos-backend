/*
  Warnings:

  - A unique constraint covering the columns `[conversationId]` on the table `ConversationMetadata` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ConversationMetadata_conversationId_key" ON "ConversationMetadata"("conversationId");
