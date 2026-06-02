-- AlterTable
-- Optional caller-supplied builder/system prompt override (admin dashboard).
-- Privileged (agent-API-key only) and fed to the generator by the executor;
-- null for ordinary generations, where the canonical prompt is used.
ALTER TABLE "AgentTemplateGeneration"
  ADD COLUMN "builderPrompt" TEXT;
