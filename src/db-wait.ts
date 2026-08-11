/**
 * Bounded database connect-wait, run by dev/entrypoint.sh BEFORE
 * `prisma migrate deploy`.
 *
 * Why this exists: CON-825 preview bundles sit on an Aurora Serverless v2
 * cluster with `min_capacity 0`. Resuming from 0 ACU takes ~15s, and 30s+ after
 * a long pause. `prisma migrate deploy` is fail-fast, so the first task of the
 * day would die on P1001 straight into the ECS circuit breaker — which, on a
 * first deploy, has no prior revision to roll back to and simply stalls.
 *
 * Why a probe rather than retrying `migrate deploy` itself: `migrate deploy`
 * exits 1 both for "database unreachable" (P1001) and for "applied migrations
 * are not in this branch" (P3009, the rebased-force-push case). The CON-825
 * deploy workflow keys its auto-reset path off the second. Retrying the migrate
 * command merges the two into a single timeout. Separating the probe keeps
 * "asleep" and "migrations are wrong" distinguishable, and keeps the migration
 * step fail-fast.
 *
 * NOT gated on PREVIEW. A connect-wait before migrate is a strict improvement
 * everywhere (a prod task started during an RDS failover crash-loops today), it
 * costs one `SELECT 1` when the database is already up, and running it in every
 * environment is the only way it is exercised outside the environment where its
 * failure is most expensive.
 */
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

export const DEFAULT_DB_CONNECT_BUDGET_SECONDS = 90;
export const DB_CONNECT_RETRY_DELAY_MS = 2_000;
/** Upper bound on the budget: past this the wait stops being fail-fast at all. */
export const MAX_DB_CONNECT_BUDGET_SECONDS = 3_600;
/**
 * Per-attempt cap. The budget alone does not bound a single probe: the loop can
 * only check the deadline once `probe()` settles, and a probe's own ceiling is
 * Prisma's `connect_timeout` (5s by default, but settable to anything in
 * DATABASE_URL). Without this cap one connection attempt could outlive the
 * whole budget and reintroduce the stall this module exists to prevent.
 */
export const DB_CONNECT_PROBE_TIMEOUT_MS = 10_000;
/**
 * Capping the probe alone is not enough: `$disconnect()` waits for the
 * connection attempt still in flight, so an unreachable host with a long
 * `connect_timeout` would stall the entrypoint inside the cleanup instead of
 * inside the probe. Measured: 2m with `connect_timeout=120`, despite a 3s
 * budget. The process is exiting either way, so a clean close is not worth it.
 */
export const DB_DISCONNECT_TIMEOUT_MS = 2_000;

export type WaitDeps = {
  /** Resolves when the database answered; rejects otherwise. */
  probe: () => Promise<void>;
  /** Monotonic-ish milliseconds. Injected so tests use a virtual clock. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
};

/**
 * Probe until success or until the budget runs out.
 * Resolves with the attempt number that succeeded; rejects with the budget
 * exceeded message, quoting the last underlying error.
 */
export async function waitForDatabase(
  budgetSeconds: number,
  deps: WaitDeps,
): Promise<number> {
  const deadline = deps.now() + budgetSeconds * 1000;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      await deps.probe();
      deps.log(`[db-wait] database reachable after ${attempt} attempt(s)`);
      return attempt;
    } catch (error) {
      // Deliberately not String(error): `error` is `unknown`, and
      // @typescript-eslint/no-base-to-string flags stringifying it. The repo's
      // existing handlers use the same instanceof-or-literal shape.
      const detail = error instanceof Error ? error.message : "unknown error";
      // Only sleep if the whole delay fits inside the remaining budget —
      // otherwise fail now rather than overshoot the deadline.
      if (deps.now() + DB_CONNECT_RETRY_DELAY_MS >= deadline) {
        throw new Error(
          `[db-wait] database not reachable within ${budgetSeconds}s ` +
            `(${attempt} attempt(s)); last error: ${detail}`,
        );
      }
      deps.log(
        `[db-wait] attempt ${attempt} failed (${detail}); ` +
          `retrying in ${DB_CONNECT_RETRY_DELAY_MS}ms`,
      );
      await deps.sleep(DB_CONNECT_RETRY_DELAY_MS);
    }
  }
}

/**
 * Reject if `promise` has not settled within `ms`.
 * The loser's rejection is deliberately absorbed: once the timer has won the
 * race, a late `$queryRaw` failure would otherwise surface as an unhandled
 * rejection, which is fatal on Node 24.
 */
export async function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = Promise.resolve(promise);
  guarded.catch(() => undefined);
  try {
    return await Promise.race([
      guarded,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    // Also stops the timer holding the event loop open on the happy path.
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Positive integer seconds from DB_CONNECT_BUDGET_SECONDS, else the default. */
export function parseBudgetSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_DB_CONNECT_BUDGET_SECONDS;
  }
  const trimmed = raw.trim();
  // Digits only: Number.parseInt("10seconds") is 10, which would silently
  // install a budget the operator never asked for.
  if (!/^\d+$/.test(trimmed)) {
    return DEFAULT_DB_CONNECT_BUDGET_SECONDS;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DB_CONNECT_BUDGET_SECONDS;
  }
  // Clamp rather than reject: a fat-fingered extra digit must not turn the
  // bounded wait into an unbounded one, which is the exact ECS-circuit-breaker
  // stall this module exists to prevent.
  return Math.min(parsed, MAX_DB_CONNECT_BUDGET_SECONDS);
}

async function main(): Promise<void> {
  const budgetSeconds = parseBudgetSeconds(
    process.env.DB_CONNECT_BUDGET_SECONDS,
  );
  // A dedicated client: the app has not started, and this one is disconnected
  // before the server process opens its own pool.
  const prisma = new PrismaClient();
  try {
    await waitForDatabase(budgetSeconds, {
      probe: async () => {
        await withTimeout(
          prisma.$queryRaw`SELECT 1`,
          DB_CONNECT_PROBE_TIMEOUT_MS,
          "[db-wait] probe",
        );
      },
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (message: string) => {
        console.log(message);
      },
    });
  } finally {
    await withTimeout(
      prisma.$disconnect(),
      DB_DISCONNECT_TIMEOUT_MS,
      "[db-wait] disconnect",
    ).catch(() => undefined);
  }
}

const entryPoint = argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown error");
    process.exit(1);
  }
}
