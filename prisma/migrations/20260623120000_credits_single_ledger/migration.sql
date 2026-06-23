-- Single-ledger wallet migration (n=1).
--
-- 1. Anchor column: the period for which we last wrote a `sub_grant` credit
--    row. Lets the grant path (and the optional reconcile cron) decide
--    "already granted this period?" without scanning the ledger.
ALTER TABLE "Subscription" ADD COLUMN "lastGrantedPeriodStart" TIMESTAMP(3);

-- 2. New GrantKind rows for the subscription money-in / money-out on the one
--    wallet. `sub_grant` is the per-period allotment; `subscription_forfeit`
--    is the bounded clawback of the unused subscription portion on expiry/
--    refund/revoke. ON CONFLICT keeps the migration idempotent.
INSERT INTO "GrantKind" ("id", "name", "description", "active", "createdAt", "updatedAt")
VALUES
  ('sub_grant',            'Subscription grant',   'Per-period subscription credit allotment', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('subscription_forfeit', 'Subscription forfeit', 'Bounded clawback of unused subscription credits on expiry/refund/revoke', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
