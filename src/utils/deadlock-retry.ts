import { Prisma } from "@prisma/client";
import logger from "@/utils/logger";

/**
 * Bounded retry for Postgres deadlock (40P01) and serialization (40001)
 * failures. Every multi-lock money transaction (claim, settlement, verify,
 * webhook apply, deletion teardown, voided-purchase compensation) wraps its
 * transaction in this helper: the transaction rolled back atomically, and
 * all of those paths are idempotent under their registry/journal/receipt
 * keys, so a clean re-run converges instead of leaking a 500/deadlock to
 * the caller.
 */

const PG_RETRYABLE_SQLSTATES = ["40P01", "40001"];

export const isRetryableTxConflict = (err: unknown): boolean => {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2034: "Transaction failed due to a write conflict or a deadlock."
    if (err.code === "P2034") return true;
  }
  if (err instanceof Error) {
    const message = err.message;
    if (PG_RETRYABLE_SQLSTATES.some((code) => message.includes(code))) {
      return true;
    }
    if (message.includes("deadlock detected")) return true;
    if (err.cause) return isRetryableTxConflict(err.cause);
  }
  return false;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const withDeadlockRetry = async <T>(
  operation: () => Promise<T>,
  opts?: { attempts?: number; label?: string },
): Promise<T> => {
  const attempts = opts?.attempts ?? 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= attempts || !isRetryableTxConflict(err)) {
        throw err;
      }
      logger.warn(
        { label: opts?.label, attempt },
        "db.deadlock_retry.restarting",
      );
      await sleep(25 * attempt + Math.floor(Math.random() * 50));
    }
  }
};
