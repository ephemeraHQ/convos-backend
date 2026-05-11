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

import logger from "@/utils/logger";
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
 * Run one sweep pass: find terminal jobs missing `expiresAt` and set it
 * to `updatedAt + 24h` for each job. Returns the number of rows updated.
 *
 * Single batch UPDATE rather than one round-trip per job — avoids N+1
 * latency when many jobs expire in the same window. Postgres computes
 * `updatedAt + interval '24 hours'` server-side, so the per-row offset
 * still derives from each row's own `updatedAt`.
 */
export async function sweepExpiredJobs(): Promise<number> {
  // TTL_MS is the source of truth; pass as milliseconds and convert to
  // a Postgres interval to avoid hard-coding "24 hours" in two places.
  const ttlSeconds = Math.floor(TTL_MS / 1000);
  const rowsUpdated = await prisma.$executeRaw`
    UPDATE "CreateJob"
    SET "expiresAt" = "updatedAt" + (${ttlSeconds} * interval '1 second')
    WHERE status IN ('done', 'failed') AND "expiresAt" IS NULL
  `;
  return rowsUpdated;
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
      logger.error({ err }, "[ttl-sweep] Error during sweep");
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
