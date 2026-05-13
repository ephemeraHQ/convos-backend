-- AlterTable
ALTER TABLE "AgentTemplateGeneration"
  ADD COLUMN "twitterContext" JSONB,
  ADD COLUMN "reply" TEXT;
