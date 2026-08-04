-- Reconciliation sweep durability:
--
-- 1. LineageQuarantine gains per-row retry state (attempts + nextAttemptAt
--    backoff, needsOperatorAt escalation) so a batch of persistent rows can
--    never starve newer recoverable ones - the sweep selects by
--    nextAttemptAt, not by a fixed oldest-N window.
--
-- 2. SubscriptionTransfer gains committedAt: the moment the journal reached
--    `committed` (settlement time for contested transfers, creation time for
--    instant moves and restores). The post-transfer drift pass cursors on
--    this - a default 72h-contested transfer's createdAt is 72 hours old by
--    the time it settles, so createdAt-based selection would skip it.

-- AlterTable
ALTER TABLE "LineageQuarantine"
    ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "needsOperatorAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SubscriptionTransfer" ADD COLUMN "committedAt" TIMESTAMP(3);

-- Backfill: every already-committed journal row committed no later than its
-- last update (settlement bumps updatedAt when it flips status).
UPDATE "SubscriptionTransfer" SET "committedAt" = "updatedAt"
WHERE "status" = 'committed' AND "committedAt" IS NULL;

-- CreateIndex
CREATE INDEX "LineageQuarantine_resolvedAt_needsOperatorAt_nextAttemptAt_idx"
    ON "LineageQuarantine"("resolvedAt", "needsOperatorAt", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SubscriptionTransfer_status_committedAt_idx"
    ON "SubscriptionTransfer"("status", "committedAt");
