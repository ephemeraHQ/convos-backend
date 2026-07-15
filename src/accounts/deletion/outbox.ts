import { getDeletionExecutor } from "@/accounts/deletion/executors";
import { PURGE_WINDOW_HOURS } from "@/accounts/deletion/service";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Deletion-outbox drain. Each sweep tick:
 *
 *   1. Drains due pending DeletionTasks (executes the purge, marks done, or
 *      schedules a retry with exponential backoff; a task exhausting its
 *      attempts goes terminal `failed` and pages an operator via logs).
 *   2. Completes DeletionRecords whose tasks are all done (stamping
 *      completedAt and the record's own expiry), and alerts on records still
 *      purging past the published purge window (SLA breach).
 *   3. Expires records (and their task rows) past their audit window — the
 *      record and outbox retain account-linked identifiers, so they get a
 *      bounded lifetime like every other retained class.
 *
 * Same setInterval lifecycle as the generation/telemetry sweeps in
 * src/index.ts.
 */

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DRAIN_BATCH_SIZE = 25;
const MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60 * 1000; // 1 hour
/** How long a completed DeletionRecord (and its task rows) is kept. */
const RECORD_AUDIT_WINDOW_DAYS = 30;

let _intervalId: ReturnType<typeof setInterval> | null = null;
let _sweepIntervalMs: number | null = DEFAULT_SWEEP_INTERVAL_MS;

/** Exponential backoff for a task that has failed `attempts` times. */
export const retryDelayMs = (attempts: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));

/**
 * Drain one batch of due pending tasks. Returns counts for observability.
 */
export const drainDeletionTasks = async (): Promise<{
  done: number;
  retried: number;
  failed: number;
}> => {
  const now = new Date();
  const due = await prisma.deletionTask.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: DRAIN_BATCH_SIZE,
  });

  let done = 0;
  let retried = 0;
  let failed = 0;

  for (const task of due) {
    const executor = getDeletionExecutor(task.kind);
    try {
      if (!executor) {
        throw new Error(`No executor for deletion task kind "${task.kind}"`);
      }
      await executor(task.payload);
      await prisma.deletionTask.update({
        where: { id: task.id },
        data: { status: "done", completedAt: new Date() },
      });
      done += 1;
    } catch (err) {
      const attempts = task.attempts + 1;
      const lastError = err instanceof Error ? err.message : String(err);
      if (attempts >= MAX_ATTEMPTS) {
        await prisma.deletionTask.update({
          where: { id: task.id },
          data: { status: "failed", attempts, lastError },
        });
        failed += 1;
        // Terminal purge failure: defined operator remediation path, never
        // silent abandonment.
        logger.error(
          {
            taskId: task.id,
            operationId: task.operationId,
            kind: task.kind,
            attempts,
            lastError,
          },
          "deletion.task.terminal_failure",
        );
      } else {
        await prisma.deletionTask.update({
          where: { id: task.id },
          data: {
            attempts,
            lastError,
            nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
          },
        });
        retried += 1;
        logger.warn(
          {
            taskId: task.id,
            operationId: task.operationId,
            kind: task.kind,
            attempts,
            lastError,
          },
          "deletion.task.retry_scheduled",
        );
      }
    }
  }

  return { done, retried, failed };
};

/**
 * Flip fully-drained records to completed (with expiry), and alert on
 * records still purging past the purge window.
 */
export const completeDeletionRecords = async (): Promise<number> => {
  const purging = await prisma.deletionRecord.findMany({
    where: { status: "purging" },
    select: { operationId: true, requestedAt: true },
  });
  let completed = 0;
  const slaBreachedOperationIds: string[] = [];
  const purgeWindowMs = PURGE_WINDOW_HOURS * 60 * 60 * 1000;

  for (const record of purging) {
    const remaining = await prisma.deletionTask.count({
      where: { operationId: record.operationId, status: { not: "done" } },
    });
    if (remaining === 0) {
      await prisma.deletionRecord.update({
        where: { operationId: record.operationId },
        data: {
          status: "completed",
          completedAt: new Date(),
          expiresAt: new Date(
            Date.now() + RECORD_AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
          ),
        },
      });
      completed += 1;
      logger.info(
        { operationId: record.operationId },
        "deletion.purge.completed",
      );
    } else if (Date.now() - record.requestedAt.getTime() > purgeWindowMs) {
      slaBreachedOperationIds.push(record.operationId);
    }
  }

  if (slaBreachedOperationIds.length > 0) {
    // Alert channel: ops pages on this event.
    logger.error(
      {
        operationIds: slaBreachedOperationIds,
        purgeWindowHours: PURGE_WINDOW_HOURS,
      },
      "deletion.purge.sla_breach",
    );
  }

  return completed;
};

/** Remove expired deletion records and their task rows. */
export const expireDeletionRecords = async (): Promise<number> => {
  const now = new Date();
  const expired = await prisma.deletionRecord.findMany({
    where: { expiresAt: { lte: now } },
    select: { operationId: true },
  });
  if (expired.length === 0) return 0;
  const operationIds = expired.map((r) => r.operationId);
  await prisma.deletionTask.deleteMany({
    where: { operationId: { in: operationIds } },
  });
  await prisma.deletionRecord.deleteMany({
    where: { operationId: { in: operationIds } },
  });
  logger.info({ operationIds }, "deletion.record.expired");
  return expired.length;
};

/** One full sweep tick; each pass isolates its own errors. */
export const runDeletionOutboxSweep = async (): Promise<void> => {
  try {
    const counts = await drainDeletionTasks();
    if (counts.done + counts.retried + counts.failed > 0) {
      logger.info(counts, "deletion.outbox.drained");
    }
  } catch (err) {
    logger.error({ err }, "deletion.outbox.drain_failed");
  }
  try {
    await completeDeletionRecords();
  } catch (err) {
    logger.error({ err }, "deletion.outbox.completion_pass_failed");
  }
  try {
    await expireDeletionRecords();
  } catch (err) {
    logger.error({ err }, "deletion.outbox.expiry_pass_failed");
  }
};

/** Test seam: override the sweep interval, or null to disable. */
export const __setDeletionSweepIntervalForTests = (ms: number | null): void => {
  _sweepIntervalMs = ms;
  if (ms === null) {
    stopDeletionOutboxSweep();
  }
};

export const startDeletionOutboxSweep = (): void => {
  if (_intervalId !== null) return;
  if (_sweepIntervalMs === null) return;
  _intervalId = setInterval(() => {
    void runDeletionOutboxSweep();
  }, _sweepIntervalMs);
  if (typeof _intervalId === "object" && "unref" in _intervalId) {
    _intervalId.unref();
  }
};

export const stopDeletionOutboxSweep = (): void => {
  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
};
