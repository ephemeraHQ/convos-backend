-- Subscription lineage rows are the canonical lockable object, with token
-- aliases, a global once-per-period funding registry, custody/escrow state,
-- the transfer journal, and quarantine.
-- Supersedes SubscriptionTombstone (tombstone becomes a lineage state); the
-- old table is retained additively so a rollback never references a dropped
-- relation.

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "lineageId" UUID;

-- CreateTable
CREATE TABLE "SubscriptionLineage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" "BillingProvider" NOT NULL,
    "lineageKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'live',
    "tombstonedAt" TIMESTAMP(3),
    "deletedAccountRef" TEXT,
    "lastTransferAt" TIMESTAMP(3),
    "lastTransferJournalId" UUID,
    "liveTransferFrozenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionLineage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineageTokenAlias" (
    "token" TEXT NOT NULL,
    "lineageId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LineageTokenAlias_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "LineagePeriodGrant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lineageId" UUID NOT NULL,
    "providerPeriodKey" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "ledgerKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LineagePeriodGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineagePeriodCustody" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lineageId" UUID NOT NULL,
    "providerPeriodKey" TEXT NOT NULL,
    "ownerAccountId" UUID,
    "remainderCap" BIGINT NOT NULL,
    "custodyStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'held',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LineagePeriodCustody_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionTransfer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lineageId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'committed',
    "fromAccountId" UUID,
    "toAccountId" UUID,
    "conservedCredits" BIGINT NOT NULL DEFAULT 0,
    "providerProof" JSONB,
    "undoOfTransferId" UUID,
    "undoneByTransferId" UUID,
    "undoDeadlineAt" TIMESTAMP(3),
    "contestEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineageQuarantine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" "BillingProvider" NOT NULL,
    "token" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "LineageQuarantine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionLineage_provider_lineageKey_key" ON "SubscriptionLineage"("provider", "lineageKey");

-- Money-state invariants, database-enforced (not just application code):
-- custody caps never go negative, states stay in their closed vocabularies,
-- and escrow custody is exactly the ownerless state.
ALTER TABLE "LineagePeriodCustody"
  ADD CONSTRAINT "LineagePeriodCustody_cap_nonnegative_check" CHECK ("remainderCap" >= 0),
  ADD CONSTRAINT "LineagePeriodCustody_state_check" CHECK ("state" IN ('held', 'escrow', 'invalidated', 'exhausted')),
  ADD CONSTRAINT "LineagePeriodCustody_owner_state_check" CHECK (
    ("state" = 'escrow' AND "ownerAccountId" IS NULL)
    OR ("state" = 'held' AND "ownerAccountId" IS NOT NULL)
    OR "state" IN ('invalidated', 'exhausted')
  );
ALTER TABLE "SubscriptionTransfer"
  ADD CONSTRAINT "SubscriptionTransfer_kind_check" CHECK ("kind" IN ('transfer', 'restore', 'undo', 'escrow')),
  ADD CONSTRAINT "SubscriptionTransfer_status_check" CHECK ("status" IN ('pending', 'committed', 'cancelled')),
  ADD CONSTRAINT "SubscriptionTransfer_conserved_nonnegative_check" CHECK ("conservedCredits" >= 0);
ALTER TABLE "SubscriptionLineage"
  ADD CONSTRAINT "SubscriptionLineage_state_check" CHECK ("state" IN ('live', 'tombstoned'));

-- CreateIndex
CREATE INDEX "LineageTokenAlias_lineageId_idx" ON "LineageTokenAlias"("lineageId");

-- CreateIndex
CREATE UNIQUE INDEX "LineagePeriodGrant_lineageId_providerPeriodKey_key" ON "LineagePeriodGrant"("lineageId", "providerPeriodKey");

-- CreateIndex
CREATE UNIQUE INDEX "LineagePeriodCustody_lineageId_providerPeriodKey_key" ON "LineagePeriodCustody"("lineageId", "providerPeriodKey");

-- CreateIndex
CREATE INDEX "LineagePeriodCustody_lineageId_state_idx" ON "LineagePeriodCustody"("lineageId", "state");

-- CreateIndex
CREATE INDEX "SubscriptionTransfer_lineageId_createdAt_idx" ON "SubscriptionTransfer"("lineageId", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionTransfer_status_contestEndsAt_idx" ON "SubscriptionTransfer"("status", "contestEndsAt");

-- CreateIndex
CREATE INDEX "LineageQuarantine_resolvedAt_createdAt_idx" ON "LineageQuarantine"("resolvedAt", "createdAt");

-- Backfill: one lineage per existing Subscription row. Apple keys on the
-- stable OTX. Google keys on the recursively discovered root of the
-- linkedPurchaseToken chain: keying on the immediate predecessor alone would
-- give a twice-rotated chain two lineage identities, and a fractured lineage
-- bypasses the global once-per-period funding registry and custody caps.
INSERT INTO "SubscriptionLineage" ("provider", "lineageKey", "state", "updatedAt")
SELECT DISTINCT s."provider", s."originalTransactionId", 'live', CURRENT_TIMESTAMP
FROM "Subscription" s
WHERE s."provider" = 'apple' AND s."originalTransactionId" IS NOT NULL
ON CONFLICT ("provider", "lineageKey") DO NOTHING;

-- Walk every Google row's predecessor chain across the rows we hold (each
-- row contributes one purchaseToken -> linkedPurchaseToken edge; the token
-- column is unique, so the walk is deterministic). The terminal token is the
-- oldest chain member we can prove; a predecessor named only by a successor
-- still terminates the walk as the root, mirroring the runtime resolver. A
-- walk that stops with a parent still pending hit a loop or the depth bound:
-- that chain is ambiguous and must never guess a monetary identity.
CREATE TEMPORARY TABLE "_google_chain_roots" ON COMMIT DROP AS
WITH RECURSIVE chain_walk AS (
  SELECT s."id" AS subscription_id,
         s."purchaseToken" AS token,
         s."linkedPurchaseToken" AS parent,
         1 AS depth,
         ARRAY[s."purchaseToken"] AS path
  FROM "Subscription" s
  WHERE s."provider" = 'googlePlay' AND s."purchaseToken" IS NOT NULL
  UNION ALL
  SELECT s."id" AS subscription_id,
         s."linkedPurchaseToken" AS token,
         (SELECT p."linkedPurchaseToken" FROM "Subscription" p
          WHERE p."provider" = 'googlePlay'
            AND p."purchaseToken" = s."linkedPurchaseToken") AS parent,
         1 AS depth,
         ARRAY[s."linkedPurchaseToken"] AS path
  FROM "Subscription" s
  WHERE s."provider" = 'googlePlay'
    AND s."purchaseToken" IS NULL
    AND s."linkedPurchaseToken" IS NOT NULL
  UNION ALL
  SELECT w.subscription_id,
         w.parent AS token,
         p."linkedPurchaseToken" AS parent,
         w.depth + 1,
         w.path || w.parent
  FROM chain_walk w
  LEFT JOIN "Subscription" p
    ON p."provider" = 'googlePlay' AND p."purchaseToken" = w.parent
  WHERE w.parent IS NOT NULL
    AND NOT w.parent = ANY(w.path)
    AND w.depth < 25
)
SELECT DISTINCT ON (subscription_id)
       subscription_id,
       token AS root_token,
       path,
       (parent IS NOT NULL) AS ambiguous
FROM chain_walk
ORDER BY subscription_id, depth DESC;

-- Ambiguous chains (loop or depth overflow) mint nothing: park them for an
-- operator and leave the rows unkeyed. They re-resolve through the runtime
-- resolver, which fails closed on the same conditions.
INSERT INTO "LineageQuarantine" ("provider", "token", "reason", "payload")
SELECT 'googlePlay'::"BillingProvider",
       COALESCE(s."purchaseToken", s."linkedPurchaseToken"),
       'backfill_chain_unresolved',
       jsonb_build_object('subscriptionId', r.subscription_id, 'chain', to_jsonb(r.path))
FROM "_google_chain_roots" r
JOIN "Subscription" s ON s."id" = r.subscription_id
WHERE r.ambiguous;

INSERT INTO "SubscriptionLineage" ("provider", "lineageKey", "state", "updatedAt")
SELECT DISTINCT 'googlePlay'::"BillingProvider", r.root_token, 'live', CURRENT_TIMESTAMP
FROM "_google_chain_roots" r
WHERE NOT r.ambiguous
ON CONFLICT ("provider", "lineageKey") DO NOTHING;

UPDATE "Subscription" s
SET "lineageId" = l."id"
FROM "SubscriptionLineage" l
WHERE s."provider" = 'apple'
  AND l."provider" = 'apple'
  AND l."lineageKey" = s."originalTransactionId";

UPDATE "Subscription" s
SET "lineageId" = l."id"
FROM "_google_chain_roots" r
JOIN "SubscriptionLineage" l
  ON l."provider" = 'googlePlay' AND l."lineageKey" = r.root_token
WHERE s."id" = r.subscription_id AND NOT r.ambiguous;

-- Alias seed: every chain member (current token, every rotated predecessor,
-- and the root itself) resolves to the chain's lineage.
INSERT INTO "LineageTokenAlias" ("token", "lineageId")
SELECT DISTINCT t.token, l."id"
FROM "_google_chain_roots" r
JOIN "SubscriptionLineage" l
  ON l."provider" = 'googlePlay' AND l."lineageKey" = r.root_token
CROSS JOIN LATERAL unnest(r.path) AS t(token)
WHERE NOT r.ambiguous
ON CONFLICT ("token") DO NOTHING;

-- Migrate any SubscriptionTombstone rows into tombstoned lineages. The old
-- table stays in place (additive-only migration: a rollback or older replica
-- that still references it must keep working); lineage state is the single
-- source of truth from here on.
INSERT INTO "SubscriptionLineage" ("provider", "lineageKey", "state", "tombstonedAt", "deletedAccountRef", "updatedAt")
SELECT t."provider", t."providerKey", 'tombstoned', t."deletedAt", t."accountRef", CURRENT_TIMESTAMP
FROM "SubscriptionTombstone" t
ON CONFLICT ("provider", "lineageKey")
DO UPDATE SET "state" = 'tombstoned',
              "tombstonedAt" = EXCLUDED."tombstonedAt",
              "deletedAccountRef" = EXCLUDED."deletedAccountRef",
              "updatedAt" = CURRENT_TIMESTAMP;

-- One live Subscription row per lineage, database-enforced (claim and
-- webhook lookups by lineageId must be deterministic). Root canonicalization
-- can map several rows of one rotated chain onto one lineage. Detaching the
-- extras is not safe: a detached row stays addressable by its token, so a
-- later verify resolves the same lineage and collides with the unique index
-- below -- a P2002 outside the recognized conflict set, surfacing as an
-- HTTP 500 (and a silently dropped update on the notification path).
--
-- Same-chain rows owned by different accounts are never merged silently:
-- fail the migration with row-level diagnostics so an operator adjudicates
-- ownership before this deploy proceeds.
DO $$
DECLARE
  conflict_row RECORD;
BEGIN
  SELECT s."lineageId"::text AS lineage_id,
         count(*) AS row_count,
         array_agg(DISTINCT s."accountId"::text) AS account_ids,
         array_agg(s."id"::text ORDER BY s."id") AS subscription_ids
    INTO conflict_row
    FROM "Subscription" s
   WHERE s."lineageId" IS NOT NULL
   GROUP BY s."lineageId"
  HAVING count(*) > 1 AND count(DISTINCT s."accountId") > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'subscription lineage % has % rows owned by different accounts % (subscription rows %): same-chain ownership must be adjudicated before this migration can run',
      conflict_row.lineage_id, conflict_row.row_count,
      conflict_row.account_ids, conflict_row.subscription_ids;
  END IF;
END $$;

-- Same-account duplicates consolidate onto one survivor: keep the row with
-- the newest entitlement window, move the losers' receipts onto it, then
-- delete the losers so no stale row remains addressable.
WITH survivors AS (
  SELECT DISTINCT ON (s."lineageId") s."id", s."lineageId"
  FROM "Subscription" s
  WHERE s."lineageId" IS NOT NULL
  ORDER BY s."lineageId", s."currentPeriodEnd" DESC, s."updatedAt" DESC, s."id"
),
losers AS (
  SELECT s."id" AS loser_id, v."id" AS survivor_id
  FROM "Subscription" s
  JOIN survivors v ON v."lineageId" = s."lineageId" AND v."id" <> s."id"
)
UPDATE "BillingReceipt" b
SET "subscriptionId" = losers.survivor_id
FROM losers
WHERE b."subscriptionId" = losers.loser_id;

DELETE FROM "Subscription" s
USING (
  SELECT DISTINCT ON ("lineageId") "id", "lineageId"
  FROM "Subscription"
  WHERE "lineageId" IS NOT NULL
  ORDER BY "lineageId", "currentPeriodEnd" DESC, "updatedAt" DESC, "id"
) survivor
WHERE s."lineageId" = survivor."lineageId" AND s."id" <> survivor."id";

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_lineageId_key" ON "Subscription"("lineageId");

-- Widen the ledger scope CHECK to admit the lineage custody-move scope
-- (claim transfers, undo, deletion escrow, refund compensation). Same
-- drop-and-re-add pattern as 20260623120000_credits_single_ledger.
ALTER TABLE "CreditLedger" DROP CONSTRAINT "CreditLedger_scope_check";
ALTER TABLE "CreditLedger"
  ADD CONSTRAINT "CreditLedger_scope_check"
  CHECK ("scope" IN ('transaction', 'grant', 'daily_refill', 'sub_forfeit', 'sub_transfer'));
