-- A curation weight is a homepage slot, and only a public template has one.
-- Zero the weight on every featured template that isn't published, so a
-- template can't inherit a slot it never earned: without this, publishing a
-- long-featured draft drops it wherever its weight happens to sit — which for
-- the weights seeded by the previous migration means a position derived from
-- its creation date, not from anyone's curation.
--
-- Published rows keep their weights, so the gallery's order is unchanged.
UPDATE "AgentTemplate"
SET "featuredRank" = 0
WHERE "featured" = true
  AND "status" <> 'published'
  AND "featuredRank" <> 0;
