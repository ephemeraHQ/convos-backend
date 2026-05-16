-- AlterTable
-- VARCHAR(128) mirrors the zod cap on the API body so the DB enforces
-- the same contract for any non-handler write path (admin, seed, etc.).
ALTER TABLE "AgentTemplateGeneration"
  ADD COLUMN "clientDeviceId" VARCHAR(128);
