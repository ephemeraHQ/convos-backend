import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { afterEach, describe, expect, test, vi } from "vitest";
import { deleteAccount } from "@/accounts/deletion/service";
import {
  __setDeviceRegistrationBeforeAccountLocksForTests,
  register,
} from "@/api/v2/device/handlers/register";
import { prisma } from "@/utils/prisma";

type MockResponse = Pick<Response, "json" | "send" | "status"> & {
  body?: unknown;
  statusCode: number;
};

const response = (): MockResponse => {
  const res = { statusCode: 200 } as MockResponse;
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res as unknown as Response;
  };
  res.json = (body) => {
    res.body = body;
    return res as unknown as Response;
  };
  res.send = () => res as unknown as Response;
  return res;
};

const request = (deviceId: string, pushToken: string) =>
  ({
    body: { deviceId, pushToken, pushTokenType: "apns" },
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }) as unknown as Request<
    unknown,
    unknown,
    { deviceId: string; pushToken: string; pushTokenType: "apns" }
  >;

const created = {
  accountIds: [] as string[],
  clientIds: [] as string[],
  deviceIds: [] as string[],
  operationIds: [] as string[],
};

afterEach(async () => {
  __setDeviceRegistrationBeforeAccountLocksForTests(null);
  await prisma.deletionTask.deleteMany({
    where: { operationId: { in: created.operationIds } },
  });
  await prisma.deletionRecord.deleteMany({
    where: { operationId: { in: created.operationIds } },
  });
  await prisma.adminAudit.deleteMany({
    where: {
      idempotencyKey: {
        in: created.operationIds.map((id) => `account_deletion_${id}`),
      },
    },
  });
  await prisma.clientIdentifier.deleteMany({
    where: { id: { in: created.clientIds } },
  });
  await prisma.deviceRegistration.deleteMany({
    where: { deviceId: { in: created.deviceIds } },
  });
  await prisma.account.deleteMany({
    where: { id: { in: created.accountIds } },
  });
  created.accountIds.length = 0;
  created.clientIds.length = 0;
  created.deviceIds.length = 0;
  created.operationIds.length = 0;
});

const seedMigration = async () => {
  const [targetAccount, sourceAccount] = await Promise.all([
    prisma.account.create({ data: {} }),
    prisma.account.create({ data: {} }),
  ]);
  const targetDeviceId = `target-${randomUUID()}`;
  const sourceDeviceId = `source-${randomUUID()}`;
  const clientId = randomUUID();
  const pushToken = `push-${randomUUID()}`;
  created.accountIds.push(targetAccount.id, sourceAccount.id);
  created.deviceIds.push(targetDeviceId, sourceDeviceId);
  created.clientIds.push(clientId);
  await prisma.deviceRegistration.createMany({
    data: [
      { accountId: targetAccount.id, deviceId: targetDeviceId },
      {
        accountId: sourceAccount.id,
        deviceId: sourceDeviceId,
        pushToken,
        pushTokenType: "apns",
      },
    ],
  });
  await prisma.clientIdentifier.create({
    data: {
      accountId: sourceAccount.id,
      deviceId: sourceDeviceId,
      id: clientId,
    },
  });
  return {
    clientId,
    pushToken,
    sourceDeviceId,
    targetAccountId: targetAccount.id,
    targetDeviceId,
  };
};

describe("device registration deletion fence", () => {
  test("does not migrate an identifier into an account being deleted", async () => {
    const fixture = await seedMigration();
    let releaseDeletion!: () => void;
    const deletionGate = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    let markAccountLocked!: () => void;
    const accountLocked = new Promise<void>((resolve) => {
      markAccountLocked = resolve;
    });
    const deleting = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT 1 FROM "Account"
        WHERE id = ${fixture.targetAccountId}::uuid
        FOR UPDATE
      `;
      markAccountLocked();
      await deletionGate;
      await tx.deviceRegistration.deleteMany({
        where: { accountId: fixture.targetAccountId },
      });
      await tx.account.delete({ where: { id: fixture.targetAccountId } });
    });
    await accountLocked;

    let markRegisterSnapshot!: () => void;
    const registerSnapshot = new Promise<void>((resolve) => {
      markRegisterSnapshot = resolve;
    });
    __setDeviceRegistrationBeforeAccountLocksForTests(() => {
      markRegisterSnapshot();
      return Promise.resolve();
    });
    const res = response();
    const registering = register(
      request(fixture.targetDeviceId, fixture.pushToken),
      res as unknown as Response,
    );
    await registerSnapshot;
    releaseDeletion();
    await deleting;
    await registering;

    expect(res.statusCode).toBe(500);
    expect(
      await prisma.clientIdentifier.findUnique({
        where: { id: fixture.clientId },
      }),
    ).toMatchObject({ deviceId: fixture.sourceDeviceId });
  });

  test("a migration committed before deletion is included in the purge snapshot", async () => {
    const fixture = await seedMigration();
    const operationId = randomUUID();
    created.operationIds.push(operationId);
    const res = response();

    await register(
      request(fixture.targetDeviceId, fixture.pushToken),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(
      await prisma.clientIdentifier.findUnique({
        where: { id: fixture.clientId },
      }),
    ).toMatchObject({ deviceId: fixture.targetDeviceId });

    await expect(
      deleteAccount({
        accountId: fixture.targetAccountId,
        operationId,
      }),
    ).resolves.not.toBeNull();
    expect(
      await prisma.deletionTask.findFirst({
        where: {
          kind: "notification_installation",
          operationId,
          payload: { path: ["installationId"], equals: fixture.clientId },
        },
      }),
    ).not.toBeNull();
  });
});
