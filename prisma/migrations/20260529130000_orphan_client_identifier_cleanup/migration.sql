-- Stack 2 / T20: one-time orphan ClientIdentifier cleanup
--
-- Production validation on a real broken phone (2026-05-29) found 24 stale
-- ClientIdentifier rows pointing at one device, accumulated over ~4 months
-- via repeated identity rotations. The NSE-driven unregister path was
-- broken upstream until T14, so XMTP installations registered by older
-- iOS identities never had their backend ClientIdentifier rows removed.
-- The orphans keep producing webhook deliveries that the iOS NSE cannot
-- decode, which presents to the user as "push arrived in APNS but no
-- banner" (the headline failure mode for the Stack 2 work).
--
-- T15's webhook accountId check (shipped in the same PR as this migration)
-- already drops orphans at the delivery boundary going forward. This
-- migration cleans up the historical data so the snapshot table that
-- ships in T10 + T11 doesn't accumulate garbage on day one.
--
-- Policy: keep the most-recently-touched ClientIdentifier row per device;
-- delete same-device rows that are both NOT the most recent AND older than
-- 7 days. The "older than 7 days" guard avoids a foot-gun on devices that
-- recently churned through multiple identities legitimately (developer
-- account switching, fresh install + signin within the same day).
--
-- Stack 2 D17a (NSE unregister middleware) is the going-forward fix that
-- stops new orphans from accumulating. Without that landing first, this
-- migration would have to re-run on every wave of churn. T14 ships in the
-- same PR.

WITH ranked AS (
  SELECT
    "id",
    "deviceId",
    "updatedAt",
    ROW_NUMBER() OVER (
      PARTITION BY "deviceId"
      ORDER BY "updatedAt" DESC
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
