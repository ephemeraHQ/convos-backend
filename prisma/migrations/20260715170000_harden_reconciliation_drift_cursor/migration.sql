-- Make SubscriptionTransfer.committedAt database-owned and rolling-safe.
--
-- Old replicas do not know this column. After this migration they may still
-- insert committed rows or flip pending rows to committed, but the default +
-- trigger below guarantee those journals receive database time. Existing
-- NULLs are backfilled before NOT NULL is installed, so no committed journal
-- can remain invisible to the composite drift cursor during a mixed-version
-- rollout.

ALTER TABLE "SubscriptionTransfer"
    ALTER COLUMN "committedAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION "stamp_subscription_transfer_committed_at"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'committed' THEN
            -- DB wall time, never an application-replica clock.
            -- clock_timestamp() also avoids inheriting a long
            -- transaction's start timestamp.
            NEW."committedAt" := clock_timestamp();
        END IF;
    ELSIF NEW.status = 'committed' THEN
        -- Every committedAt write remains database-owned. This also lets the
        -- post-install backfill normalize journals written before the trigger
        -- acquired its table lock without accepting a caller's future stamp.
        NEW."committedAt" := clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SubscriptionTransfer_stamp_committed_at"
BEFORE INSERT OR UPDATE OF status, "committedAt"
ON "SubscriptionTransfer"
FOR EACH ROW
EXECUTE FUNCTION "stamp_subscription_transfer_committed_at"();

-- Protection is live before either backfill. Normalize every committed row,
-- including a non-null application timestamp written before trigger install;
-- a fresh monitoring window is conservative and compensation is idempotent.
UPDATE "SubscriptionTransfer"
SET "committedAt" = clock_timestamp()
WHERE status = 'committed';

-- Pending rows only need a non-null placeholder for the rolling-safe
-- constraint; the trigger replaces it when status first becomes committed.
UPDATE "SubscriptionTransfer"
SET "committedAt" = COALESCE("updatedAt", CURRENT_TIMESTAMP)
WHERE "committedAt" IS NULL;

ALTER TABLE "SubscriptionTransfer"
    ALTER COLUMN "committedAt" SET NOT NULL;

-- Supports the exact deterministic keyset order used by the sweep. Keep the
-- prior two-column index for additive rollout; it can be retired separately.
CREATE INDEX "SubscriptionTransfer_status_committedAt_id_idx"
    ON "SubscriptionTransfer"("status", "committedAt", id);
