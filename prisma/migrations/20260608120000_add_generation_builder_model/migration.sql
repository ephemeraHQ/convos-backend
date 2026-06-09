-- AlterTable
-- Optional caller-supplied model override (admin dashboard). Privileged
-- (agent-API-key only) and used by the executor for the main generation call;
-- null for ordinary generations, where the default builder model is used.
ALTER TABLE "AgentTemplateGeneration"
  ADD COLUMN "builderModel" VARCHAR(256);
