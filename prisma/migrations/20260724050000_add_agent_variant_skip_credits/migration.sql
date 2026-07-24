-- AlterTable
-- Agents created from this variant skip the credit path (server-side admin
-- signal via the join's variant descriptor). Defaults to true — the same
-- credits-exempt default the worker applies to a descriptor without the flag.
ALTER TABLE "AgentVariant" ADD COLUMN "skipCredits" BOOLEAN NOT NULL DEFAULT true;
