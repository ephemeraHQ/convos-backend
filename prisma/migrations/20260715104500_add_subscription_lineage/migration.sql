-- Subscription lineage model (reclaim v3): lineage rows as the canonical
-- lockable object, token aliases, the global once-per-period funding
-- registry, custody/escrow state, the transfer journal, and quarantine.
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
-- stable OTX; Google keys on the oldest chain member we know
-- (linkedPurchaseToken when present, else the current token).
INSERT INTO "SubscriptionLineage" ("provider", "lineageKey", "state", "updatedAt")
SELECT DISTINCT s."provider", s."originalTransactionId", 'live', CURRENT_TIMESTAMP
FROM "Subscription" s
WHERE s."provider" = 'apple' AND s."originalTransactionId" IS NOT NULL
ON CONFLICT ("provider", "lineageKey") DO NOTHING;

INSERT INTO "SubscriptionLineage" ("provider", "lineageKey", "state", "updatedAt")
SELECT DISTINCT s."provider", COALESCE(s."linkedPurchaseToken", s."purchaseToken"), 'live', CURRENT_TIMESTAMP
FROM "Subscription" s
WHERE s."provider" = 'googlePlay' AND COALESCE(s."linkedPurchaseToken", s."purchaseToken") IS NOT NULL
ON CONFLICT ("provider", "lineageKey") DO NOTHING;

UPDATE "Subscription" s
SET "lineageId" = l."id"
FROM "SubscriptionLineage" l
WHERE l."provider" = s."provider"
  AND l."lineageKey" = CASE
    WHEN s."provider" = 'apple' THEN s."originalTransactionId"
    ELSE COALESCE(s."linkedPurchaseToken", s."purchaseToken")
  END;

-- Alias seed: current and predecessor Google tokens resolve to the lineage.
INSERT INTO "LineageTokenAlias" ("token", "lineageId")
SELECT s."purchaseToken", s."lineageId"
FROM "Subscription" s
WHERE s."provider" = 'googlePlay' AND s."purchaseToken" IS NOT NULL AND s."lineageId" IS NOT NULL
ON CONFLICT ("token") DO NOTHING;

INSERT INTO "LineageTokenAlias" ("token", "lineageId")
SELECT s."linkedPurchaseToken", s."lineageId"
FROM "Subscription" s
WHERE s."provider" = 'googlePlay' AND s."linkedPurchaseToken" IS NOT NULL AND s."lineageId" IS NOT NULL
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
-- webhook lookups by lineageId must be deterministic). Defensive dedupe
-- first: keep the row with the newest entitlement window, detach the rest
-- (they re-resolve through verify).
UPDATE "Subscription" s SET "lineageId" = NULL
WHERE s."lineageId" IS NOT NULL
  AND s."id" <> (
    SELECT s2."id" FROM "Subscription" s2
    WHERE s2."lineageId" = s."lineageId"
    ORDER BY s2."currentPeriodEnd" DESC, s2."updatedAt" DESC
    LIMIT 1
  );

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_lineageId_key" ON "Subscription"("lineageId");

-- Widen the ledger scope CHECK to admit the lineage custody-move scope
-- (claim transfers, undo, deletion escrow, refund compensation). Same
-- drop-and-re-add pattern as 20260623120000_credits_single_ledger.
ALTER TABLE "CreditLedger" DROP CONSTRAINT "CreditLedger_scope_check";
ALTER TABLE "CreditLedger"
  ADD CONSTRAINT "CreditLedger_scope_check"
  CHECK ("scope" IN ('transaction', 'grant', 'daily_refill', 'sub_forfeit', 'sub_transfer'));
