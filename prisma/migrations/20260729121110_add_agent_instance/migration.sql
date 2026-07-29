-- AgentInstance only. `prisma migrate dev` also wanted to emit pre-existing
-- schema/migration drift (CreditLedger/UserCredits FK re-validation, UUID
-- default drops, Subscription index renames) — deliberately excluded here:
-- locking the ledger tables is not this feature's business, and that drift
-- predates this branch.

-- CreateTable
CREATE TABLE "AgentInstance" (
    "instanceId" TEXT NOT NULL,
    "ownerAccountId" UUID NOT NULL,
    "conversationId" TEXT,
    "inboxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentInstance_pkey" PRIMARY KEY ("instanceId")
);

-- CreateIndex
CREATE INDEX "AgentInstance_conversationId_idx" ON "AgentInstance"("conversationId");

-- CreateIndex
CREATE INDEX "AgentInstance_ownerAccountId_idx" ON "AgentInstance"("ownerAccountId");

-- AddForeignKey
ALTER TABLE "AgentInstance" ADD CONSTRAINT "AgentInstance_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
