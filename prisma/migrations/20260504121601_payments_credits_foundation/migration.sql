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
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrantKind_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "inboxId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "LedgerReason" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "usdCostMicros" BIGINT,
    "markupRate" DECIMAL(8,4),
    "creditsPerDollar" INTEGER,
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
CREATE UNIQUE INDEX "CreditLedger_inboxId_idempotencyKey_key" ON "CreditLedger"("inboxId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_grantKindId_fkey" FOREIGN KEY ("grantKindId") REFERENCES "GrantKind"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed GrantKind rows
INSERT INTO "GrantKind" ("id", "name", "description", "active", "createdAt") VALUES
  ('signup_bonus',  'Signup Bonus',  'Granted once on first agent creation', true, now()),
  ('daily_refill',  'Daily Refill',  'Periodic top-up via cron',             true, now()),
  ('manual',        'Manual Grant',  'Operator-initiated grant',             true, now());
