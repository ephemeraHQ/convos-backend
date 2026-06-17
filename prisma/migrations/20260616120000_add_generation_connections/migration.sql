-- AlterTable
-- Neutral service ids (e.g. "googlecalendar") the caller flagged the agent as
-- using. Validated against the supported-services catalog
-- (src/api/v2/connections/bundles.config.ts) at submit; the executor appends a
-- capabilities directive to the generator and overlays these onto the produced
-- template's `connections`. Open input (no privileged gate): stamping a
-- connection grants nothing — the grant is issued later, at provisioning.
--
-- NOT NULL with an array default to match Prisma's `String[] @default([])`
-- exactly; backfills existing rows to the empty array.
ALTER TABLE "AgentTemplateGeneration"
  ADD COLUMN "connections" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
