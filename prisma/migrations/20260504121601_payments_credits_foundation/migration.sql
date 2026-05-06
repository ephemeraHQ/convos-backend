-- CreateEnum
CREATE TYPE "LedgerReason" AS ENUM ('consume', 'grant', 'refill', 'adjust');

-- CreateTable
CREATE TABLE "UserCredits" (
    "inboxId" TEXT NOT NULL,
    "balance" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCredits_pkey" PRIMARY KEY ("inboxId")
);

-- CreateTable
CREATE TABLE "GrantKind" (
    "id" VARCHAR(64) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrantKind_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" UUID NOT NULL,
    "inboxId" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "reason" "LedgerReason" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "usdCostMicros" BIGINT,
    "markupRate" DECIMAL(8,4),
    "creditsPerDollar" BIGINT,
    "model" TEXT,
    "requestId" TEXT,
    "note" TEXT,
    "grantKindId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditLedger_inboxId_createdAt_idx" ON "CreditLedger"("inboxId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedger_requestId_idx" ON "CreditLedger"("requestId");

-- CreateIndex
CREATE INDEX "CreditLedger_grantKindId_idx" ON "CreditLedger"("grantKindId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_inboxId_idempotencyKey_key" ON "CreditLedger"("inboxId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_grantKindId_fkey" FOREIGN KEY ("grantKindId") REFERENCES "GrantKind"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed GrantKind rows
INSERT INTO "GrantKind" ("id", "name", "description", "active", "createdAt", "updatedAt") VALUES ('signup_bonus', 'Signup Bonus', 'Granted once on first agent creation', true, now(), now()) ON CONFLICT ("id") DO NOTHING;
INSERT INTO "GrantKind" ("id", "name", "description", "active", "createdAt", "updatedAt") VALUES ('daily_refill', 'Daily Refill', 'Periodic top-up via cron',             true, now(), now()) ON CONFLICT ("id") DO NOTHING;
INSERT INTO "GrantKind" ("id", "name", "description", "active", "createdAt", "updatedAt") VALUES ('manual',       'Manual Grant', 'Operator-initiated grant',             true, now(), now()) ON CONFLICT ("id") DO NOTHING;
