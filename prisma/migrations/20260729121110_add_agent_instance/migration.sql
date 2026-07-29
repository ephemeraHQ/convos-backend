-- DropForeignKey
ALTER TABLE "CreditLedger" DROP CONSTRAINT "CreditLedger_accountId_fkey";

-- DropForeignKey
ALTER TABLE "UserCredits" DROP CONSTRAINT "UserCredits_accountId_fkey";

-- AlterTable
ALTER TABLE "AgentTemplate" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "AgentTemplateGeneration" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "InviteCode" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "InviteCodeRedemption" ALTER COLUMN "id" DROP DEFAULT;

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
ALTER TABLE "UserCredits" ADD CONSTRAINT "UserCredits_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentInstance" ADD CONSTRAINT "AgentInstance_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "subscription_apple_aat_unique" RENAME TO "Subscription_provider_appAccountToken_key";

-- RenameIndex
ALTER INDEX "subscription_apple_otx_unique" RENAME TO "Subscription_provider_originalTransactionId_key";

-- RenameIndex
ALTER INDEX "subscription_play_oid_unique" RENAME TO "Subscription_provider_obfuscatedAccountId_key";

-- RenameIndex
ALTER INDEX "subscription_play_token_unique" RENAME TO "Subscription_provider_purchaseToken_key";
