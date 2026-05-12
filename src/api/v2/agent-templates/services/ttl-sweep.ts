/**
 * TTL + stuck-row sweep for AgentTemplateGeneration rows.
 *
 * Two passes per sweep tick:
 *
 *   1. **TTL pass** — terminal rows (`done`/`failed`) without `expiresAt`
 *      get it set to `updatedAt + GENERATION_TTL_HOURS` (default 24h).
 *      Expired rows remain in the DB; the GET handler hides them.
 *
 *   2. **Stuck-row pass** — `running` rows whose `updatedAt` is older than
 *      `GENERATION_STUCK_SWEEP_THRESHOLD_MS` (default 10 min) get marked
 *      `failed` with a stuck-process error message. Complements the
 *      in-process 5-min timeout in generation-executor — that timer fires
 *      from inside the executor process and dies if the process dies.
 *      This sweep catches the genuinely-crashed cases.
 *
 * Design:
 *   - Runs every 60 seconds via `setInterval` (test-overridable).
 *   - Pending rows are NEVER touched (they have no claim yet).
 *   - Single batch UPDATE per pass — no N+1.
 *
 * Test seam: `__setSweepIntervalForTests(ms | null)` to control the sweep
 * timing in tests, or `null` to disable it entirely.
 */

import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default sweep interval: 60 seconds. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Default TTL for terminal generations: 24 hours. */
const DEFAULT_TTL_HOURS = 24;

/** Default stuck-row threshold: 10 minutes (must be > the 5-min in-process timeout). */
const DEFAULT_STUCK_THRESHOLD_MS = 10 * 60 * 1000;

function getTtlSeconds(): number {
  const raw = process.env.GENERATION_TTL_HOURS;
  const hours = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(hours) && hours > 0) return hours * 3600;
  return DEFAULT_TTL_HOURS * 3600;
}

function getStuckThresholdMs(): number {
  // Keep the threshold in milliseconds (and use a millisecond Postgres
  // interval below) so sub-second overrides like `500` don't truncate to
  // zero and match *every* running row.
  const raw = process.env.GENERATION_STUCK_SWEEP_THRESHOLD_MS;
  const ms = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(ms) && ms > 0) return ms;
  return DEFAULT_STUCK_THRESHOLD_MS;
}

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
 * Pass 1: Set `expiresAt` on terminal rows that are missing it.
 * Returns the number of rows updated.
 */
export async function sweepTerminalTtl(): Promise<number> {
  const ttlSeconds = getTtlSeconds();
  const rowsUpdated = await prisma.$executeRaw`
    UPDATE "AgentTemplateGeneration"
    SET "expiresAt" = "updatedAt" + (${ttlSeconds} * interval '1 second')
    WHERE status IN ('done', 'failed') AND "expiresAt" IS NULL
  `;
  return rowsUpdated;
}

/**
 * Pass 2: Mark stuck `running` rows as `failed`.
 * A row is "stuck" if its `updatedAt` is older than the threshold —
 * the in-process 5-min timeout should have caught it if the executor
 * was still alive, so beyond the threshold we assume process crash.
 *
 * Returns the number of rows updated.
 */
export async function sweepStuckRows(): Promise<number> {
  const stuckMs = getStuckThresholdMs();
  const ttlSeconds = getTtlSeconds();
  const rowsUpdated = await prisma.$executeRaw`
    UPDATE "AgentTemplateGeneration"
    SET status = 'failed',
        error = 'Generation stuck — likely process crash',
        "expiresAt" = NOW() + (${ttlSeconds} * interval '1 second'),
        "updatedAt" = NOW()
    WHERE status = 'running'
      AND "updatedAt" < NOW() - (${stuckMs} * interval '1 millisecond')
  `;
  return rowsUpdated;
}

/**
 * Run one full sweep pass — both TTL and stuck-row checks.
 * Errors in either pass are swallowed and logged so they don't poison
 * each other or kill the interval.
 */
export async function runSweep(): Promise<void> {
  try {
    const ttlCount = await sweepTerminalTtl();
    if (ttlCount > 0) {
      logger.debug(
        { ttlCount },
        "[ttl-sweep] TTL pass set expiresAt on terminal rows",
      );
    }
  } catch (err) {
    logger.error({ err }, "[ttl-sweep] TTL pass failed");
  }

  try {
    const stuckCount = await sweepStuckRows();
    if (stuckCount > 0) {
      logger.warn(
        { stuckCount },
        "[ttl-sweep] Stuck-row pass marked running rows as failed",
      );
    }
  } catch (err) {
    logger.error({ err }, "[ttl-sweep] Stuck-row pass failed");
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the TTL sweep interval.
 * Safe to call multiple times — will not create duplicate intervals.
 */
export function startTtlSweep(): void {
  if (_intervalId !== null) return;
  if (_sweepIntervalMs === null) return;

  _intervalId = setInterval(() => {
    void runSweep();
  }, _sweepIntervalMs);

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
