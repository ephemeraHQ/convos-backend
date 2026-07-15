-- DropIndex
DROP INDEX "CreditLedger_grantKindId_idx";

-- CreateIndex
CREATE INDEX "CreditLedger_grantKindId_createdAt_idx" ON "CreditLedger"("grantKindId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedger_reason_accountId_createdAt_idx" ON "CreditLedger"("reason", "accountId", "createdAt");

-- CreateIndex
CREATE INDEX "UserCredits_balance_idx" ON "UserCredits"("balance");
