import { randomUUID } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { __setDeletionNotificationClientForTests } from "@/accounts/deletion/executors";
import {
  completeDeletionRecords,
  drainDeletionTasks,
} from "@/accounts/deletion/outbox";
import { prisma } from "@/utils/prisma";

/**
 * The notification-installation purge must classify NotFound/Unimplemented
 * (the notification server answering "already gone" — a bare HTTP 404 maps
 * to `unimplemented` in the Connect protocol) as SUCCESS, so the task and
 * its DeletionRecord complete instead of retrying to terminal failure.
 * Genuine transient errors keep their retry semantics.
 */

const stubClient = (error: ConnectError) => {
  const deleteInstallation = vi.fn(() => Promise.reject(error));
  __setDeletionNotificationClientForTests({ deleteInstallation });
  return deleteInstallation;
};

const newRecordWithInstallationTask = async () => {
  const operationId = randomUUID();
  await prisma.deletionRecord.create({
    data: { operationId, accountRef: `ref-${operationId.slice(0, 8)}` },
  });
  await prisma.deletionTask.create({
    data: {
      operationId,
      kind: "notification_installation",
      // No ClientIdentifier row exists for this id, so the mutation fence
      // sees the expected "absent" local state and calls the remote delete.
      payload: { installationId: randomUUID() },
    },
  });
  return operationId;
};

afterEach(async () => {
  __setDeletionNotificationClientForTests(null);
  await prisma.deletionTask.deleteMany();
  await prisma.deletionRecord.deleteMany();
});

describe("notification purge with an already-absent installation", () => {
  test("NotFound completes the task and the record", async () => {
    const operationId = await newRecordWithInstallationTask();
    const deleteInstallation = stubClient(
      new ConnectError("installation not found", Code.NotFound),
    );

    await expect(drainDeletionTasks()).resolves.toEqual({
      done: 1,
      retried: 0,
      failed: 0,
    });
    expect(deleteInstallation).toHaveBeenCalledTimes(1);

    await expect(completeDeletionRecords()).resolves.toBe(1);
    const record = await prisma.deletionRecord.findUnique({
      where: { operationId },
    });
    expect(record?.status).toBe("completed");
    expect(record?.completedAt).not.toBeNull();
  });

  test("a bare HTTP 404 (unimplemented) is already-gone, not a retry", async () => {
    const operationId = await newRecordWithInstallationTask();
    // Live shape: ConnectError "[unimplemented] HTTP 404" from a
    // notification server that no longer serves the route.
    stubClient(new ConnectError("HTTP 404", Code.Unimplemented));

    await expect(drainDeletionTasks()).resolves.toEqual({
      done: 1,
      retried: 0,
      failed: 0,
    });
    await expect(completeDeletionRecords()).resolves.toBe(1);
    const record = await prisma.deletionRecord.findUnique({
      where: { operationId },
    });
    expect(record?.status).toBe("completed");
  });

  test("a transient failure still retries and the record stays purging", async () => {
    const operationId = await newRecordWithInstallationTask();
    stubClient(new ConnectError("HTTP 503", Code.Unavailable));

    await expect(drainDeletionTasks()).resolves.toEqual({
      done: 0,
      retried: 1,
      failed: 0,
    });
    const task = await prisma.deletionTask.findFirst({
      where: { operationId },
    });
    expect(task).toMatchObject({ status: "pending", attempts: 1 });
    expect(task?.lastError).toContain("HTTP 503");
    expect(task?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await expect(completeDeletionRecords()).resolves.toBe(0);
    const record = await prisma.deletionRecord.findUnique({
      where: { operationId },
    });
    expect(record?.status).toBe("purging");
  });
});
