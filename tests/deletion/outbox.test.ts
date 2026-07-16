import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { __setDeletionExecutorsForTests } from "@/accounts/deletion/executors";
import {
  completeDeletionRecords,
  drainDeletionTasks,
  expireDeletionRecords,
  retryDelayMs,
  runDeletionOutboxSweep,
} from "@/accounts/deletion/outbox";
import { prisma } from "@/utils/prisma";

const wipe = async () => {
  __setDeletionExecutorsForTests(null);
  await prisma.deletionTask.deleteMany();
  await prisma.deletionRecord.deleteMany();
};

afterEach(wipe);

const newRecord = async () => {
  const operationId = randomUUID();
  await prisma.deletionRecord.create({
    data: { operationId, accountRef: `ref-${operationId.slice(0, 8)}` },
  });
  return operationId;
};

const newTask = (
  operationId: string,
  kind = "notification_installation",
  overrides: Record<string, unknown> = {},
) =>
  prisma.deletionTask.create({
    data: {
      operationId,
      kind,
      payload: { installationId: "client-1" },
      ...overrides,
    },
  });

describe("deletion outbox drain", () => {
  test("failure schedules a retry with backoff and records the error", async () => {
    const operationId = await newRecord();
    __setDeletionExecutorsForTests({
      notification_installation: () =>
        Promise.reject(new Error("remote unavailable")),
    });
    const task = await newTask(operationId);

    const counts = await drainDeletionTasks();
    expect(counts).toEqual({ done: 0, retried: 1, failed: 0 });

    const updated = await prisma.deletionTask.findUnique({
      where: { id: task.id },
    });
    expect(updated?.status).toBe("pending");
    expect(updated?.attempts).toBe(1);
    expect(updated?.lastError).toContain("remote unavailable");
    expect(updated?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // A not-yet-due task is not re-executed.
    const again = await drainDeletionTasks();
    expect(again).toEqual({ done: 0, retried: 0, failed: 0 });
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(20)).toBe(60 * 60 * 1000);
  });

  test("exhausted attempts go terminal failed", async () => {
    const operationId = await newRecord();
    __setDeletionExecutorsForTests({
      notification_installation: () =>
        Promise.reject(new Error("still broken")),
    });
    const task = await newTask(operationId, "notification_installation", {
      attempts: 9,
    });

    const counts = await drainDeletionTasks();
    expect(counts).toEqual({ done: 0, retried: 0, failed: 1 });
    const updated = await prisma.deletionTask.findUnique({
      where: { id: task.id },
    });
    expect(updated?.status).toBe("failed");
    expect(updated?.attempts).toBe(10);
  });
});

describe("deletion record completion and expiry", () => {
  test("record stays purging while tasks remain pending or failed", async () => {
    const operationId = await newRecord();
    await newTask(operationId, "notification_installation", {
      status: "failed",
      attempts: 10,
    });
    await completeDeletionRecords();
    const record = await prisma.deletionRecord.findUnique({
      where: { operationId },
    });
    expect(record?.status).toBe("purging");
  });

  test("expired records and their tasks are removed", async () => {
    const operationId = await newRecord();
    await newTask(operationId, "notification_installation", {
      status: "done",
    });
    await prisma.deletionRecord.update({
      where: { operationId },
      data: {
        status: "completed",
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const expired = await expireDeletionRecords();
    expect(expired).toBe(1);
    expect(await prisma.deletionRecord.count({ where: { operationId } })).toBe(
      0,
    );
    expect(await prisma.deletionTask.count({ where: { operationId } })).toBe(0);
  });

  test("full sweep drains, completes, and leaves fresh records alone", async () => {
    const operationId = await newRecord();
    __setDeletionExecutorsForTests({
      notification_installation: () => Promise.resolve(),
      composio_user: () => Promise.resolve(),
      posthog_person: () => Promise.resolve(),
      s3_object: () => Promise.resolve(),
    });
    await newTask(operationId, "notification_installation");
    await newTask(operationId, "composio_user", {
      payload: { accountId: randomUUID() },
    });
    await newTask(operationId, "s3_object", {
      payload: { target: "private", key: "build/abc" },
    });

    await runDeletionOutboxSweep();

    const record = await prisma.deletionRecord.findUnique({
      where: { operationId },
    });
    expect(record?.status).toBe("completed");
    expect(
      await prisma.deletionTask.count({
        where: { operationId, status: "done" },
      }),
    ).toBe(3);
  });
});
