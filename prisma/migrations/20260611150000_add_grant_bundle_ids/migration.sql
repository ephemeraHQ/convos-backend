-- Permission bundles for connection grants.
--
-- iOS/Android persist human-named *bundle ids* (e.g. "calendar.events") instead
-- of Composio action slugs; POST /v2/composio/exec resolves a bundle to its
-- actions against the backend catalog (src/api/v2/connections/bundles.config.ts).
-- serviceVersion is the catalog version the client granted against, stored for
-- audit/telemetry only — exec always resolves against the CURRENT catalog.
--
-- NOTE: bundleIds is NOT NULL with an array default to match Prisma's
-- `String[] @default([])` exactly (the earlier `actions` column shipped as a
-- nullable TEXT[] by mistake — not repeated here).

-- AlterTable
ALTER TABLE "ConnectionGrant"
    ADD COLUMN "bundleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "serviceVersion" INTEGER;
