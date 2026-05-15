-- CreateEnum
CREATE TYPE "LedgerReason" AS ENUM ('consume', 'grant', 'refill', 'adjust');

-- CreateTable
CREATE TABLE "UserCredits" (
    "accountId" UUID NOT NULL,
    "balance" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCredits_pkey" PRIMARY KEY ("accountId")
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
    "accountId" UUID NOT NULL,
    "delta" BIGINT NOT NULL,
    "reason" "LedgerReason" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "usdCostMicros" BIGINT,
    "markupRate" DECIMAL(8,4),
    "creditsPerDollar" BIGINT,
    "model" TEXT,
    "requestId" TEXT,
    "note" TEXT,
    "grantKindId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditLedger_accountId_createdAt_idx" ON "CreditLedger"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedger_requestId_idx" ON "CreditLedger"("requestId");

-- CreateIndex
CREATE INDEX "CreditLedger_grantKindId_idx" ON "CreditLedger"("grantKindId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_accountId_idempotencyKey_key" ON "CreditLedger"("accountId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "UserCredits" ADD CONSTRAINT "UserCredits_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_grantKindId_fkey" FOREIGN KEY ("grantKindId") REFERENCES "GrantKind"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed GrantKind rows
INSERT INTO "GrantKind" ("id", "name", "description", "active", "createdAt", "updatedAt")
VALUES
  ('signup_bonus', 'Signup bonus', 'Granted once on first agent creation', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('daily_refill', 'Daily refill', 'Daily credit refill', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('manual',       'Manual grant', 'Admin-issued grant', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
