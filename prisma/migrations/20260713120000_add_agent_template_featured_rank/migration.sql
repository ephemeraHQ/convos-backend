-- AlterTable
-- Curation weight for the featured gallery, sorted descending (heaviest leads).
-- 0 = unranked, which sorts below every curated row.
ALTER TABLE "AgentTemplate" ADD COLUMN "featuredRank" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "AgentTemplate_status_featured_featuredRank_id_idx" ON "AgentTemplate"("status", "featured", "featuredRank", "id");

-- Seed the weights from the order the gallery already renders — `createdAt`
-- desc, id desc — so switching the site to sort by `featuredRank` is a no-op
-- until someone curates. Reversing that comparator (createdAt asc, id asc)
-- makes the oldest row weight 1 and the newest row weight N, which reads back
-- newest-first under a descending sort. Non-featured rows keep 0.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC) AS rank
  FROM "AgentTemplate"
  WHERE "featured" = true
)
UPDATE "AgentTemplate" AS t
SET "featuredRank" = ranked.rank
FROM ranked
WHERE t."id" = ranked."id";
