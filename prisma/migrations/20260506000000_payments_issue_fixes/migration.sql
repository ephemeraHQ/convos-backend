-- AlterTable: widen delta from Int to BigInt
ALTER TABLE "CreditLedger" ALTER COLUMN "delta" SET DATA TYPE BIGINT;

-- AlterTable: widen creditsPerDollar from Int to BigInt
ALTER TABLE "CreditLedger" ALTER COLUMN "creditsPerDollar" SET DATA TYPE BIGINT;

-- AlterTable: drop balanceAfter column
ALTER TABLE "CreditLedger" DROP COLUMN "balanceAfter";

-- CreateIndex
CREATE INDEX "CreditLedger_grantKindId_idx" ON "CreditLedger"("grantKindId");
