-- Replace the global drift cursor with a durable schedule per lineage.
--
-- Rolling order matters: create the table, install the trigger that captures
-- every new committed journal from old or new replicas, then backfill all
-- journals already present. A writer that commits before trigger installation
-- is included by the later backfill; a writer after installation schedules
-- itself in the same transaction as its journal.

CREATE TABLE "SubscriptionDriftSchedule" (
    "lineageId" UUID NOT NULL,
    "nextDriftCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monitorUntil" TIMESTAMP(3) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    "needsOperatorAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionDriftSchedule_pkey" PRIMARY KEY ("lineageId"),
    CONSTRAINT "SubscriptionDriftSchedule_lineageId_fkey"
        FOREIGN KEY ("lineageId") REFERENCES "SubscriptionLineage"(id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SubscriptionDriftSchedule_due_idx"
    ON "SubscriptionDriftSchedule"("resolvedAt", "needsOperatorAt", "nextDriftCheckAt", "lineageId");
CREATE INDEX "SubscriptionDriftSchedule_monitor_idx"
    ON "SubscriptionDriftSchedule"("resolvedAt", "monitorUntil");

CREATE OR REPLACE FUNCTION "schedule_subscription_transfer_drift"()
RETURNS TRIGGER AS $$
BEGIN
    -- Ignore idempotent updates to an already committed journal. A new
    -- schedule window begins only on insert, first commitment, kind change,
    -- or committedAt maintenance.
    IF TG_OP = 'INSERT' THEN
        IF NEW.status IS DISTINCT FROM 'committed'
           OR NEW.kind NOT IN ('transfer', 'restore', 'undo') THEN
            RETURN NEW;
        END IF;
    ELSIF NEW.status IS DISTINCT FROM 'committed'
          OR NEW.kind NOT IN ('transfer', 'restore', 'undo')
          OR NOT (
              OLD.status IS DISTINCT FROM NEW.status
              OR OLD.kind IS DISTINCT FROM NEW.kind
              OR OLD."committedAt" IS DISTINCT FROM NEW."committedAt"
          ) THEN
        RETURN NEW;
    END IF;

    INSERT INTO "SubscriptionDriftSchedule" (
        "lineageId",
        "nextDriftCheckAt",
        "monitorUntil",
        attempts,
        "needsOperatorAt",
        "resolvedAt",
        "updatedAt"
    ) VALUES (
        NEW."lineageId",
        NEW."committedAt",
        NEW."committedAt" + INTERVAL '24 hours',
        0,
        NULL,
        NULL,
        clock_timestamp()
    )
    ON CONFLICT ("lineageId") DO UPDATE SET
        -- A lineage can accumulate journals. Preserve the earliest due
        -- check and union their monitoring windows; never let an older
        -- journal shorten the latest commit's full 24-hour window.
        "nextDriftCheckAt" = LEAST(
            "SubscriptionDriftSchedule"."nextDriftCheckAt",
            EXCLUDED."nextDriftCheckAt"
        ),
        "monitorUntil" = GREATEST(
            "SubscriptionDriftSchedule"."monitorUntil",
            EXCLUDED."monitorUntil"
        ),
        attempts = 0,
        "needsOperatorAt" = NULL,
        "resolvedAt" = NULL,
        "updatedAt" = clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SubscriptionTransfer_schedule_drift"
AFTER INSERT OR UPDATE OF status, kind, "committedAt"
ON "SubscriptionTransfer"
FOR EACH ROW
EXECUTE FUNCTION "schedule_subscription_transfer_drift"();

-- Backfill after trigger installation closes the only mixed-version gap.
-- One provider check covers the lineage, so MIN supplies its oldest due time
-- while MAX unions every qualifying journal's 24-hour monitoring deadline.
INSERT INTO "SubscriptionDriftSchedule" (
    "lineageId",
    "nextDriftCheckAt",
    "monitorUntil",
    attempts,
    "needsOperatorAt",
    "resolvedAt",
    "updatedAt"
)
SELECT
    "lineageId",
    MIN("committedAt"),
    MAX("committedAt") + INTERVAL '24 hours',
    0,
    NULL,
    NULL,
    clock_timestamp()
FROM "SubscriptionTransfer"
WHERE status = 'committed'
  AND kind IN ('transfer', 'restore', 'undo')
GROUP BY "lineageId"
ON CONFLICT ("lineageId") DO UPDATE SET
    "nextDriftCheckAt" = LEAST(
        "SubscriptionDriftSchedule"."nextDriftCheckAt",
        EXCLUDED."nextDriftCheckAt"
    ),
    "monitorUntil" = GREATEST(
        "SubscriptionDriftSchedule"."monitorUntil",
        EXCLUDED."monitorUntil"
    ),
    attempts = 0,
    "needsOperatorAt" = NULL,
    "resolvedAt" = NULL,
    "updatedAt" = clock_timestamp();
