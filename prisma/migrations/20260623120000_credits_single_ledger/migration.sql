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

-- 3. Widen the CreditLedger scope domain to admit the subscription clawback
--    scope. Migration 20260522091106 pinned the CHECK to
--    ('transaction', 'grant', 'daily_refill'); the single-ledger forfeit path
--    writes scope = 'subscription_forfeit', which that constraint rejects with
--    Postgres error 23514. (Per-period subscription grants reuse scope = 'grant'
--    with grantKindId = 'sub_grant', so they were already admitted.) Drop and
--    re-add the constraint with the new value included. Safe to add immediately:
--    no existing row carries a value outside the widened set.
ALTER TABLE "CreditLedger" DROP CONSTRAINT "CreditLedger_scope_check";
ALTER TABLE "CreditLedger"
  ADD CONSTRAINT "CreditLedger_scope_check"
  CHECK ("scope" IN ('transaction', 'grant', 'daily_refill', 'subscription_forfeit'));
