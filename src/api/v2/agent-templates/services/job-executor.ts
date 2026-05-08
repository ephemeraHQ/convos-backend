/**
 * CreateJob background executor — stub for endpoint feature.
 *
 * The full executor (state machine: pending → generating → provisioning → done|failed)
 * will be implemented in the create-job-execution feature. This stub provides:
 *   - A fire-and-forget entry point for the POST handler
 *   - A test seam to mock or observe executor calls
 *   - Sets expiresAt on terminal jobs (TTL 24h)
 *
 * The POST handler calls `void executeCreateJob(jobId).catch(...)` — fire-and-forget.
 */

import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobExecutorOverride {
  executeJob?: (jobId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for terminal jobs: 24 hours in milliseconds. */
const TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

let _override: JobExecutorOverride | null = null;

/**
 * Install a test override for the job executor.
 * Pass `null` to restore normal behaviour.
 */
export function __resetJobExecutorForTests(
  override: JobExecutorOverride | null,
): void {
  _override = override;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute a create-job asynchronously.
 *
 * This stub version:
 * 1. Sets expiresAt on terminal jobs that don't have it
 * 2. Can be overridden for testing
 *
 * The full implementation (create-job-execution feature) will add:
 * - pending → generating (call templateGen)
 * - generating → provisioning (persist draft AgentTemplate, call PlaygroundClient)
 * - provisioning → done|failed (poll playground)
 */
export async function executeCreateJob(jobId: string): Promise<void> {
  // Test seam: delegate to override if installed
  if (_override?.executeJob) {
    return _override.executeJob(jobId);
  }

  // Stub: ensure terminal jobs have expiresAt set.
  // This handles the case where a job is already in a terminal state
  // but doesn't have expiresAt (e.g., set directly in tests).
  const job = await prisma.createJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  if (
    (job.status === "done" || job.status === "failed") &&
    job.expiresAt === null
  ) {
    const expiresAt = new Date(Date.now() + TTL_MS);
    await prisma.createJob.update({
      where: { id: jobId },
      data: { expiresAt },
    });
  }
}
