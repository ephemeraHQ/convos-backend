-- CreateEnum
CREATE TYPE "SubscriptionTier" AS ENUM ('builder', 'pro');

-- CreateEnum
CREATE TYPE "SubscriptionPeriod" AS ENUM ('monthly', 'annual');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trial', 'active', 'grace', 'billingRetry', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "AppleEnv" AS ENUM ('sandbox', 'production');

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "accountId" UUID NOT NULL,
    "productId" TEXT NOT NULL,
    "tier" "SubscriptionTier" NOT NULL,
    "period" "SubscriptionPeriod" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "originalTransactionId" TEXT NOT NULL,
    "appAccountToken" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "willRenew" BOOLEAN NOT NULL DEFAULT true,
    "isInTrial" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "gracePeriodEnd" TIMESTAMP(3),
    "environment" "AppleEnv" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppleReceipt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscriptionId" UUID NOT NULL,
    "transactionId" TEXT NOT NULL,
    "notificationType" TEXT NOT NULL,
    "notificationSubtype" TEXT,
    "signedPayload" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppleReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_originalTransactionId_key" ON "Subscription"("originalTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_appAccountToken_key" ON "Subscription"("appAccountToken");

-- CreateIndex
CREATE INDEX "Subscription_accountId_idx" ON "Subscription"("accountId");

-- CreateIndex
CREATE INDEX "Subscription_status_currentPeriodEnd_idx" ON "Subscription"("status", "currentPeriodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "AppleReceipt_transactionId_key" ON "AppleReceipt"("transactionId");

-- CreateIndex
CREATE INDEX "AppleReceipt_subscriptionId_receivedAt_idx" ON "AppleReceipt"("subscriptionId", "receivedAt");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppleReceipt" ADD CONSTRAINT "AppleReceipt_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
