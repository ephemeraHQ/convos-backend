-- AlterTable
-- LLM-generated short role label for share cards (≤3 words, no word >10
-- chars). Nullable; templates generated before this column stay null (no
-- backfill).
ALTER TABLE "AgentTemplate" ADD COLUMN "jobTitle" TEXT;
