import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  __setSubscribeNotificationClientForTests,
  subscribe,
} from "@/api/v2/notifications/handlers/subscribe";
import { prisma } from "@/utils/prisma";

type MockResponse = Pick<Response, "json" | "send" | "status"> & {
  body?: unknown;
  locals: Response["locals"];
  statusCode: number;
};

const response = (accountId: string, deviceId: string): MockResponse => {
  const res = {
    locals: { accountId, deviceId },
    statusCode: 200,
  } as MockResponse;
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res as Response;
  };
  res.json = (body) => {
    res.body = body;
    return res as Response;
  };
  res.send = () => res as Response;
  return res;
};

const created = {
  accountIds: [] as string[],
  clientIds: [] as string[],
  deviceIds: [] as string[],
};

afterEach(async () => {
  __setSubscribeNotificationClientForTests(null);
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
});

describe("notification subscription deletion fence", () => {
  test("holds the account lock until remote registration finishes", async () => {
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

    let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let markRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      markRegistrationStarted = resolve;
    });
    __setSubscribeNotificationClientForTests({
      deleteInstallation: vi.fn(() => Promise.resolve({})),
      registerInstallation: vi.fn(async () => {
        markRegistrationStarted();
        await registrationGate;
        return {};
      }),
      subscribeWithMetadata: vi.fn(() => Promise.resolve({})),
    } as unknown as Parameters<
      typeof __setSubscribeNotificationClientForTests
    >[0]);

    const req = {
      body: {
        deviceId,
        clientId,
        topics: [{ topic: "topic-1", hmacKeys: [] }],
      },
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    } as unknown as Request<
      unknown,
      unknown,
      {
        deviceId: string;
        clientId: string;
        topics: Array<{ topic: string; hmacKeys: never[] }>;
      }
    >;
    const res = response(account.id, deviceId);

    const subscribing = subscribe(req, res as Response);
    await registrationStarted;

    let accountDeleteSettled = false;
    const accountDelete = prisma.account
      .delete({ where: { id: account.id } })
      .then(() => {
        accountDeleteSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(accountDeleteSettled).toBe(false);

    releaseRegistration();
    await subscribing;
    expect(res.statusCode).toBe(200);
    await accountDelete;
    expect(accountDeleteSettled).toBe(true);
  });
});
