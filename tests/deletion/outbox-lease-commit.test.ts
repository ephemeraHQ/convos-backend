import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * drainDeletionTasks holds the outbox advisory lock in a transaction whose
 * ONLY job is the lock — the per-task writes commit on the pooled client.
 * A lease timeout on transaction close after the drain finished therefore
 * must not discard the computed counts (the work is durable); a failure
 * before the drain completed is a genuine drain failure and propagates.
 */

const txClient = {
  $queryRaw: vi.fn(() => Promise.resolve([{ locked: true }])),
};

let transactionImpl: (
  cb: (tx: typeof txClient) => Promise<unknown>,
) => Promise<unknown> = async (cb) => cb(txClient);

vi.mock("@/utils/prisma", () => ({
  prisma: {
    // Pooled drain reads/writes: no stale claims, one due task that the
    // executor completes — the drain reports { done: 1 }.
    deletionTask: {
      updateMany: vi.fn((args: { where?: { updatedAt?: unknown } }) =>
        // Only the stale-claim reclaim filters on updatedAt — report none;
        // the claim and completion transitions each touch one row.
        Promise.resolve({ count: args.where?.updatedAt ? 0 : 1 }),
      ),
      findMany: vi.fn(() =>
        Promise.resolve([
          {
            id: "task-1",
            operationId: "op-1",
            kind: "notification_installation",
            payload: { installationId: "client-1" },
            status: "pending",
            attempts: 0,
            nextAttemptAt: new Date(0),
          },
        ]),
      ),
    },
    get $transaction() {
      return (cb: (tx: typeof txClient) => Promise<unknown>) =>
        transactionImpl(cb);
    },
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $connect: vi.fn().mockResolvedValue(undefined),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("drainDeletionTasks lease-close semantics", () => {
  test("a commit-time lease failure after a completed drain returns the counts", async () => {
    const { __setDeletionExecutorsForTests } =
      await import("@/accounts/deletion/executors");
    __setDeletionExecutorsForTests({
      notification_installation: () => Promise.resolve(),
    });
    const { drainDeletionTasks } = await import("@/accounts/deletion/outbox");

    // The callback runs to completion, then the transaction's close fails
    // (lease timed out under a long batch).
    transactionImpl = async (cb) => {
      await cb(txClient);
      throw new Error("Transaction already closed: lease timed out");
    };

    await expect(drainDeletionTasks()).resolves.toEqual({
      done: 1,
      retried: 0,
      failed: 0,
    });
    __setDeletionExecutorsForTests(null);
  });

  test("a failure before the drain completes still propagates", async () => {
    const { drainDeletionTasks } = await import("@/accounts/deletion/outbox");

    transactionImpl = () =>
      Promise.reject(new Error("could not acquire connection"));

    await expect(drainDeletionTasks()).rejects.toThrow(
      "could not acquire connection",
    );
  });
});
