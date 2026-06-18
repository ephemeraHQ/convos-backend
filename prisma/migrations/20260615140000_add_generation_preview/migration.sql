-- AlterTable
-- In-progress poll fields written by the generation executor's distill stage
-- and surfaced only on 202 responses: `preview` is the draft agent identity
-- ({ agentName, emoji, description }); `progressPhrases` is the build-narration
-- array. Both are omitted from the terminal 200. Nullable; no backfill.
ALTER TABLE "AgentTemplateGeneration"
  ADD COLUMN "preview" JSONB,
  ADD COLUMN "progressPhrases" JSONB;
