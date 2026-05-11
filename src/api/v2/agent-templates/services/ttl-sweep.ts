/**
 * TTL sweep for CreateJob rows.
 *
 * Periodically finds terminal jobs (done/failed) that are missing
 * `expiresAt` and sets it to `updatedAt + 24h`. Also, the GET endpoint
 * treats jobs with `expiresAt < NOW()` as expired (returns 404).
 *
 * Design:
 *   - Runs every 60 seconds via `setInterval`
 *   - Non-terminal jobs (pending/generating/provisioning) are NEVER touched
 *   - Terminal jobs without `expiresAt` get it set to `updatedAt + 24h`
 *   - Expired rows remain in the DB (not auto-deleted) — only hidden from GET
 *
 * Test seam: `__setSweepIntervalForTests(ms | null)` to control the sweep
 * timing in tests, or `null` to disable it.
 */

import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default sweep interval: 60 seconds. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** TTL for terminal jobs: 24 hours. */
const TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _intervalId: ReturnType<typeof setInterval> | null = null;
let _sweepIntervalMs: number | null = DEFAULT_SWEEP_INTERVAL_MS;

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Override the sweep interval for tests.
 * Pass `null` to disable the sweep entirely (and stop any running interval).
 * Call before `startTtlSweep`.
 */
export function __setSweepIntervalForTests(ms: number | null): void {
  _sweepIntervalMs = ms;
  if (ms === null) {
    stopTtlSweep();
  }
}

// ---------------------------------------------------------------------------
// Sweep logic
// ---------------------------------------------------------------------------

/**
 * Run one sweep pass: find terminal jobs missing `expiresAt` and set it.
 * Sets expiresAt = updatedAt + 24h for each job.
 * Returns the number of rows updated.
 */
export async function sweepExpiredJobs(): Promise<number> {
  // Find terminal jobs where expiresAt is NULL
  const jobs = await prisma.createJob.findMany({
    where: {
      status: { in: ["done", "failed"] },
      expiresAt: null,
    },
    select: { id: true, updatedAt: true },
  });

  if (jobs.length === 0) return 0;

  // Update each job with expiresAt = updatedAt + 24h
  // This ensures each job gets its own expiry based on when it completed
  const updates = jobs.map((job) =>
    prisma.createJob.update({
      where: { id: job.id },
      data: {
        expiresAt: new Date(job.updatedAt.getTime() + TTL_MS),
      },
    }),
  );

  await Promise.all(updates);
  return jobs.length;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the TTL sweep interval.
 * Safe to call multiple times — will not create duplicate intervals.
 */
export function startTtlSweep(): void {
  if (_intervalId !== null) return; // already running
  if (_sweepIntervalMs === null) return; // disabled

  _intervalId = setInterval(() => {
    void sweepExpiredJobs().catch((err: unknown) => {
      // Log but don't crash — sweep is best-effort
      console.error("[ttl-sweep] Error during sweep:", err);
    });
  }, _sweepIntervalMs);

  // Allow the process to exit even if the interval is running
  if (typeof _intervalId === "object" && "unref" in _intervalId) {
    _intervalId.unref();
  }
}

/**
 * Stop the TTL sweep interval.
 */
export function stopTtlSweep(): void {
  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}
