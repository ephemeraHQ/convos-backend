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
        await prisma.$queryRaw`SELECT 1`;
      },
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (message: string) => {
        console.log(message);
      },
    });
  } finally {
    await prisma.$disconnect();
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
