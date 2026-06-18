-- CreateTable
CREATE TABLE "AdminAudit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "accountId" UUID NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "deltaCredits" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminAudit_accountId_idempotencyKey_key" ON "AdminAudit"("accountId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AdminAudit_accountId_createdAt_idx" ON "AdminAudit"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAudit_actorEmail_createdAt_idx" ON "AdminAudit"("actorEmail", "createdAt");
