-- Add scope column with DEFAULT (kept permanently — rollback safety)
ALTER TABLE "CreditLedger"
  ADD COLUMN "scope" VARCHAR(32) NOT NULL DEFAULT 'transaction';

-- Add balanceAfter column nullable for backfill window
ALTER TABLE "CreditLedger" ADD COLUMN "balanceAfter" BIGINT;

-- Check constraint on scope domain (safe to add immediately — all existing rows have valid value)
ALTER TABLE "CreditLedger"
  ADD CONSTRAINT "CreditLedger_scope_check"
  CHECK ("scope" IN ('transaction', 'grant', 'daily_refill'));

-- Backfill scope for daily-refill rows.
-- Order-dependent with the next UPDATE: this one MUST run first.
UPDATE "CreditLedger"
SET "scope" = 'daily_refill'
WHERE "reason" = 'grant'
  AND ("grantKindId" = 'daily_refill' OR "idempotencyKey" LIKE 'daily_refill:%');

-- Backfill scope for non-daily grants (signup_bonus, manual).
-- Depends on the previous UPDATE having already moved daily rows out of the 'transaction' bucket.
UPDATE "CreditLedger"
SET "scope" = 'grant'
WHERE "reason" = 'grant'
  AND "scope" = 'transaction';

-- Backfill balanceAfter using running SUM ordered by (createdAt ASC, id ASC) per account.
-- Idempotent: only updates rows where balanceAfter IS NULL.
WITH ordered AS (
  SELECT
    "id",
    SUM("delta") OVER (
      PARTITION BY "accountId"
      ORDER BY "createdAt" ASC, "id" ASC
      ROWS UNBOUNDED PRECEDING
    ) AS running_balance
  FROM "CreditLedger"
)
UPDATE "CreditLedger" cl
SET "balanceAfter" = ordered.running_balance
FROM ordered
WHERE cl."id" = ordered."id"
  AND cl."balanceAfter" IS NULL;
