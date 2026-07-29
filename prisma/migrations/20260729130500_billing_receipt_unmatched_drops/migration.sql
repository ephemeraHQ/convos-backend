-- BillingReceipt: support unmatched-drop receipts.
--
-- Provider notifications (Apple SSN / Play RTDN) that match no Subscription
-- row were previously acked with a log line only — invisible outside logs.
-- They are now persisted as BillingReceipt rows with subscriptionId NULL and
-- the provider-side subscription identity (Apple originalTransactionId /
-- Google purchaseToken) in providerSubscriptionId, so "notifications arriving
-- for subscriptions we don't know" is queryable and auditable from the DB.
-- The existing UNIQUE on idempotencyKey (apple-ssn:{notificationUUID} /
-- play-rtdn:{messageId}) makes the drop write idempotent per notification.
--
-- The subscriptionId foreign key itself is untouched (stays ON DELETE
-- RESTRICT): NULLs are always permitted by an FK constraint.

-- AlterTable
ALTER TABLE "BillingReceipt" ALTER COLUMN "subscriptionId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "BillingReceipt" ADD COLUMN "providerSubscriptionId" TEXT;

-- CreateIndex
CREATE INDEX "BillingReceipt_providerSubscriptionId_idx" ON "BillingReceipt"("providerSubscriptionId");
