-- One-time orphan ClientIdentifier cleanup.
--
-- Production validation on a real broken phone (2026-05-29) found 24 stale
-- ClientIdentifier rows pointing at one device, accumulated over ~4 months
-- via repeated identity rotations. The XMTP notifications server keeps
-- webhooking us for those orphans; the iOS NSE cannot decode them, which
-- presents to the user as "push arrived in APNS but no banner".
--
-- The webhook accountId check shipped in the same PR as this migration
-- already drops orphans at the delivery boundary going forward. This
-- migration cleans up the historical data.
--
-- Policy: keep the most-recently-touched ClientIdentifier row per device;
-- delete same-device rows that are both NOT the most recent AND older than
-- 7 days. The "older than 7 days" guard avoids a foot-gun on devices that
-- recently churned through multiple identities legitimately (developer
-- account switching, fresh install + signin within the same day).

-- ORDER BY must match the backfill migration's tiebreak chain
-- ("updatedAt" DESC, "addedAt" DESC, "id"). If timestamps tie, an
-- inconsistent tiebreak would let cleanup delete the same row the
-- backfill stamped with accountId, leaving a NULL-accountId orphan as
-- the surviving "latest" row.
WITH ranked AS (
  SELECT
    "id",
    "deviceId",
    "updatedAt",
    ROW_NUMBER() OVER (
      PARTITION BY "deviceId"
      ORDER BY "updatedAt" DESC, "addedAt" DESC, "id"
    ) AS rn
  FROM "ClientIdentifier"
)
DELETE FROM "ClientIdentifier"
WHERE "id" IN (
  SELECT "id"
  FROM ranked
  WHERE rn > 1
    AND "updatedAt" < NOW() - INTERVAL '7 days'
);
