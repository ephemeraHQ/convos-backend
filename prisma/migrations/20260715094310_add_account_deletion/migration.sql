-- Account deletion: barrier, deletion record, purge outbox, billing
-- tombstones, and the lastAuthAt activity stamp. Purely additive.

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "lastAuthAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DeletedIdentity" (
    "identityHash" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeletedIdentity_pkey" PRIMARY KEY ("identityHash")
);

-- CreateTable
CREATE TABLE "DeletionRecord" (
    "operationId" UUID NOT NULL,
    "accountRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'purging',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeletionRecord_pkey" PRIMARY KEY ("operationId")
);

-- CreateTable
CREATE TABLE "DeletionTask" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "operationId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DeletionTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionTombstone" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" "BillingProvider" NOT NULL,
    "providerKey" TEXT NOT NULL,
    "accountRef" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeletionRecord_accountRef_idx" ON "DeletionRecord"("accountRef");

-- CreateIndex
CREATE INDEX "DeletionRecord_status_requestedAt_idx" ON "DeletionRecord"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "DeletionRecord_expiresAt_idx" ON "DeletionRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "DeletionTask_status_nextAttemptAt_idx" ON "DeletionTask"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "DeletionTask_operationId_idx" ON "DeletionTask"("operationId");

-- CreateIndex
CREATE INDEX "SubscriptionTombstone_accountRef_idx" ON "SubscriptionTombstone"("accountRef");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionTombstone_provider_providerKey_key" ON "SubscriptionTombstone"("provider", "providerKey");

-- Backfill: existing accounts start their activity clock at migration time.
-- A null lastAuthAt must never read as "inactive/no veto" (reclaim design v2
-- finding 5); after this backfill, null only ever means a brand-new account
-- that has not minted yet.
UPDATE "Account" SET "lastAuthAt" = CURRENT_TIMESTAMP WHERE "lastAuthAt" IS NULL;
