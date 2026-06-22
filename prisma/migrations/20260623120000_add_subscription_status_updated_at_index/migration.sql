-- Backs the entitlement reconcile cron's expired/revoked "rescue" scan, which
-- filters on `status IN (...) AND updatedAt >= rescueFloor`. The existing
-- [status, currentPeriodEnd] index cannot serve the `updatedAt` bound, so this
-- index avoids a sequential scan over the expired/revoked tail.
CREATE INDEX "Subscription_status_updatedAt_idx" ON "Subscription"("status", "updatedAt");
