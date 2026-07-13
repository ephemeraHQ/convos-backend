-- A curation weight is a slot in the convos.org featured gallery, and the
-- gallery renders exactly the templates that are `featured` AND `published`.
-- Anything else holds no slot, so it holds no weight.
--
-- Without this a template inherits a slot nobody gave it. Publishing a
-- long-featured draft drops it wherever the weight seeded by the previous
-- migration happens to sit — a position derived from its creation date, not
-- from anyone's curation. And a template that was unfeatured or unpublished
-- keeps its weight, silently reclaiming its old slot when it comes back.
--
-- Rows that are featured AND published keep their weights, so the gallery's
-- rendered order is unchanged.
UPDATE "AgentTemplate"
SET "featuredRank" = 0
WHERE "featuredRank" <> 0
  AND ("featured" = false OR "status" <> 'published');
