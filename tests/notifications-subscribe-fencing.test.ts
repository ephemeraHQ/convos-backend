import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  __setDeletionNotificationClientForTests,
  getDeletionExecutor,
} from "@/accounts/deletion/executors";
import { deleteAccount } from "@/accounts/deletion/service";
import {
  __setSubscribeNotificationClientForTests,
  subscribe,
} from "@/api/v2/notifications/handlers/subscribe";
import { prisma } from "@/utils/prisma";

type MockResponse = Pick<Response, "json" | "send" | "setHeader" | "status"> & {
  body?: unknown;
  headers: Record<string, string>;
  locals: Response["locals"];
  statusCode: number;
};

const response = (accountId: string, deviceId: string): MockResponse => {
  const res = {
    headers: {},
    locals: { accountId, deviceId },
    statusCode: 200,
  } as MockResponse;
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res as unknown as Response;
  };
  res.json = (body) => {
    res.body = body;
    return res as unknown as Response;
  };
  res.send = () => res as unknown as Response;
  res.setHeader = (name, value) => {
    res.headers[name] = String(value);
    return res as unknown as Response;
  };
  return res;
};

const request = (deviceId: string, clientId: string) =>
  ({
    body: {
      deviceId,
      clientId,
      topics: [{ topic: "topic-1", hmacKeys: [] }],
    },
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }) as unknown as Request<
    unknown,
    unknown,
    {
      deviceId: string;
      clientId: string;
      topics: Array<{ topic: string; hmacKeys: never[] }>;
    }
  >;

const created = {
  accountIds: [] as string[],
  clientIds: [] as string[],
  deviceIds: [] as string[],
  operationIds: [] as string[],
};

afterEach(async () => {
  __setDeletionNotificationClientForTests(null);
  __setSubscribeNotificationClientForTests(null);
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

describe("notification subscription deletion fence", () => {
  test("commits before remote work and compensates a device-owner deletion", async () => {
    const [jwtAccount, deviceAccount, priorAccount] = await Promise.all([
      prisma.account.create({ data: {} }),
      prisma.account.create({ data: {} }),
      prisma.account.create({ data: {} }),
    ]);
    const deviceId = `subscribe-${randomUUID()}`;
    const clientId = randomUUID();
    const operationId = randomUUID();
    created.accountIds.push(jwtAccount.id, deviceAccount.id, priorAccount.id);
    created.deviceIds.push(deviceId);
    created.clientIds.push(clientId);
    created.operationIds.push(operationId);
    await prisma.deviceRegistration.create({
      data: {
        accountId: deviceAccount.id,
        deviceId,
        pushToken: `push-${randomUUID()}`,
        pushTokenType: "apns",
        clientIdentifiers: {
          create: { id: clientId, accountId: priorAccount.id },
        },
      },
    });

    let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let markRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      markRegistrationStarted = resolve;
    });
    const deleteInstallation = vi.fn(() => Promise.resolve({}));
    __setSubscribeNotificationClientForTests({
      deleteInstallation,
      registerInstallation: vi.fn(async () => {
        markRegistrationStarted();
        await registrationGate;
        return {};
      }),
      subscribeWithMetadata: vi.fn(() => Promise.resolve({})),
    } as unknown as Parameters<
      typeof __setSubscribeNotificationClientForTests
    >[0]);

    const res = response(jwtAccount.id, deviceId);
    const subscribing = subscribe(
      request(deviceId, clientId),
      res as unknown as Response,
    );
    await registrationStarted;

    expect(
      await prisma.clientIdentifier.findUnique({ where: { id: clientId } }),
    ).toMatchObject({ accountId: jwtAccount.id, deviceId });
    await expect(
      deleteAccount({ accountId: deviceAccount.id, operationId }),
    ).resolves.not.toBeNull();
    expect(
      await prisma.deletionTask.findFirst({
        where: {
          operationId,
          kind: "notification_installation",
          payload: { path: ["installationId"], equals: clientId },
        },
      }),
    ).not.toBeNull();

    releaseRegistration();
    await subscribing;
    expect(res.statusCode).toBe(401);
    expect(deleteInstallation).toHaveBeenCalledWith(
      { installationId: clientId },
      { timeoutMs: 10_000 },
    );
  });

  test("a deletion that commits before the short fence prevents registration", async () => {
    const account = await prisma.account.create({ data: {} });
    const deviceId = `subscribe-${randomUUID()}`;
    const clientId = randomUUID();
    created.accountIds.push(account.id);
    created.deviceIds.push(deviceId);
    created.clientIds.push(clientId);
    await prisma.deviceRegistration.create({
      data: {
        accountId: account.id,
        deviceId,
        pushToken: `push-${randomUUID()}`,
        pushTokenType: "apns",
      },
    });
    await prisma.account.delete({ where: { id: account.id } });

    const registerInstallation = vi.fn(() => Promise.resolve({}));
    __setSubscribeNotificationClientForTests({
      deleteInstallation: vi.fn(() => Promise.resolve({})),
      registerInstallation,
      subscribeWithMetadata: vi.fn(() => Promise.resolve({})),
    } as unknown as Parameters<
      typeof __setSubscribeNotificationClientForTests
    >[0]);
    const res = response(account.id, deviceId);

    await subscribe(request(deviceId, clientId), res as unknown as Response);

    expect(res.statusCode).toBe(401);
    expect(registerInstallation).not.toHaveBeenCalled();
    expect(
      await prisma.clientIdentifier.findUnique({ where: { id: clientId } }),
    ).toBeNull();
  });

  test("an unfinished purge blocks reassignment of the installation id", async () => {
    const account = await prisma.account.create({ data: {} });
    const deviceId = `subscribe-${randomUUID()}`;
    const clientId = randomUUID();
    const operationId = randomUUID();
    created.accountIds.push(account.id);
    created.deviceIds.push(deviceId);
    created.clientIds.push(clientId);
    created.operationIds.push(operationId);
    await prisma.deviceRegistration.create({
      data: {
        accountId: account.id,
        deviceId,
        pushToken: `push-${randomUUID()}`,
      },
    });
    await prisma.deletionRecord.create({
      data: { operationId, accountRef: `ref-${operationId}` },
    });
    await prisma.deletionTask.create({
      data: {
        operationId,
        kind: "notification_installation",
        payload: { installationId: clientId },
      },
    });

    const registerInstallation = vi.fn(() => Promise.resolve({}));
    __setSubscribeNotificationClientForTests({
      deleteInstallation: vi.fn(() => Promise.resolve({})),
      registerInstallation,
      subscribeWithMetadata: vi.fn(() => Promise.resolve({})),
    } as unknown as Parameters<
      typeof __setSubscribeNotificationClientForTests
    >[0]);
    const res = response(account.id, deviceId);

    await subscribe(request(deviceId, clientId), res as unknown as Response);

    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe("5");
    expect(registerInstallation).not.toHaveBeenCalled();
    expect(
      await prisma.clientIdentifier.findUnique({ where: { id: clientId } }),
    ).toBeNull();
  });

  test("a purge skips an installation id that has been re-registered", async () => {
    const account = await prisma.account.create({ data: {} });
    const deviceId = `subscribe-${randomUUID()}`;
    const clientId = randomUUID();
    created.accountIds.push(account.id);
    created.deviceIds.push(deviceId);
    created.clientIds.push(clientId);
    await prisma.deviceRegistration.create({
      data: {
        accountId: account.id,
        deviceId,
        clientIdentifiers: {
          create: { id: clientId, accountId: account.id },
        },
      },
    });
    const deleteInstallation = vi.fn(() => Promise.resolve({}));
    __setDeletionNotificationClientForTests({
      deleteInstallation,
    } as unknown as Parameters<
      typeof __setDeletionNotificationClientForTests
    >[0]);
    const executor = getDeletionExecutor("notification_installation");

    await expect(
      executor?.({ installationId: clientId }),
    ).resolves.toBeUndefined();
    expect(deleteInstallation).not.toHaveBeenCalled();

    await prisma.clientIdentifier.delete({ where: { id: clientId } });
    await expect(
      executor?.({ installationId: clientId }),
    ).resolves.toBeUndefined();
    expect(deleteInstallation).toHaveBeenCalledWith({
      installationId: clientId,
    });
  });

  test("registration failure removes the committed identifier best-effort", async () => {
    const account = await prisma.account.create({ data: {} });
    const deviceId = `subscribe-${randomUUID()}`;
    const clientId = randomUUID();
    created.accountIds.push(account.id);
    created.deviceIds.push(deviceId);
    created.clientIds.push(clientId);
    await prisma.deviceRegistration.create({
      data: {
        accountId: account.id,
        deviceId,
        pushToken: `push-${randomUUID()}`,
      },
    });
    const deleteInstallation = vi.fn(() => Promise.resolve({}));
    __setSubscribeNotificationClientForTests({
      deleteInstallation,
      registerInstallation: vi.fn(() =>
        Promise.reject(new Error("registration unavailable")),
      ),
      subscribeWithMetadata: vi.fn(() => Promise.resolve({})),
    } as unknown as Parameters<
      typeof __setSubscribeNotificationClientForTests
    >[0]);
    const res = response(account.id, deviceId);

    await subscribe(request(deviceId, clientId), res as unknown as Response);

    expect(res.statusCode).toBe(500);
    expect(deleteInstallation).toHaveBeenCalledTimes(1);
    expect(
      await prisma.clientIdentifier.findUnique({ where: { id: clientId } }),
    ).toBeNull();
  });
});
