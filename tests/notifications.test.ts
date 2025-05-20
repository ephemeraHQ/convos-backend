import type { Server } from "http";
import { DeviceOS } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import { uint8ArrayToHex } from "uint8array-extras";
import type {
  IRegisterInstallationResponse,
  RegisterInstallationRequestBody,
} from "@/api/v1/notifications/handlers/register-installation";
import { notificationsRouter } from "@/api/v1/notifications/notifications.router";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { createNotificationClient } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

const app = express();
app.use(jsonMiddleware);
app.use(pinoMiddleware);

const AUTH_XMTP_ID = "test-auth-xmtp-id";

app.use((req, res, next) => {
  req.app.locals.xmtpId = AUTH_XMTP_ID;
  next();
});

app.use("/notifications", notificationsRouter);

let server: Server;
const notificationClient = createNotificationClient();

const genericTestInstallationId1 = "test-install-id-1-for-subs";
const genericTestInstallationId2 = "test-install-id-2-for-meta-subs";
const genericTestInstallationId3 = "test-install-id-3-for-unsub";
const genericTestInstallationId4 = "test-install-id-4-for-unsub-validate";

beforeAll(() => {
  server = app.listen(3008);
});

afterAll(async () => {
  await prisma.$disconnect();
  server.close();
});

describe("/notifications API - Register/Unregister (Auth Required)", () => {
  let testUserId: string;
  let testDeviceId: string;
  let testIdentityId: string;
  const testUserTurnkeyId = "reg-unreg-turnkey-user-id";
  const testDeviceName = "RegUnreg Test Device";
  const testIdentityTurnkeyAddress = "reg-unreg-turnkey-address";

  beforeEach(async () => {
    await prisma.identitiesOnDevice.deleteMany();
    await prisma.profile.deleteMany();
    await prisma.conversationMetadata.deleteMany();
    await prisma.deviceIdentity.deleteMany();
    await prisma.device.deleteMany();
    await prisma.user.deleteMany();

    const user = await prisma.user.create({
      data: { turnkeyUserId: testUserTurnkeyId },
    });
    testUserId = user.id;

    const identity = await prisma.deviceIdentity.create({
      data: {
        userId: testUserId,
        xmtpId: AUTH_XMTP_ID,
        turnkeyAddress: testIdentityTurnkeyAddress,
      },
    });
    testIdentityId = identity.id;

    const device = await prisma.device.create({
      data: { userId: testUserId, name: testDeviceName, os: DeviceOS.ios },
    });
    testDeviceId = device.id;

    await prisma.identitiesOnDevice.create({
      data: { deviceId: testDeviceId, identityId: testIdentityId },
    });
  });

  afterEach(async () => {
    try {
      await notificationClient.deleteInstallation({
        installationId: "test-installation-id-register",
      });
      await notificationClient.deleteInstallation({
        installationId: "test-installation-id-unregister-setup",
      });
      await notificationClient.deleteInstallation({
        installationId: "test-forbidden-device-install-id",
      });
    } catch {
      /* ignore */
    }
  });

  test("POST /notifications/register creates a new installation", async () => {
    const testXmtpInstallationId = "test-installation-id-register";
    const response = await fetch(
      "http://localhost:3008/notifications/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "current",
          deviceId: testDeviceId,
          expoToken: "test-expo-token-register",
          pushToken: "test-push-token-register",
          installations: [
            {
              identityId: testIdentityId,
              xmtpInstallationId: testXmtpInstallationId,
            },
          ],
        } satisfies RegisterInstallationRequestBody),
      },
    );

    expect(response.status).toBe(201);
    const data = (await response.json()) as IRegisterInstallationResponse;
    expect(data[0].status).toBe("success");

    const iod = await prisma.identitiesOnDevice.findUnique({
      where: {
        deviceId_identityId: {
          deviceId: testDeviceId,
          identityId: testIdentityId,
        },
      },
    });
    expect(iod?.xmtpInstallationId).toBe(testXmtpInstallationId);
    const device = await prisma.device.findUnique({
      where: { id: testDeviceId },
    });
    expect(device?.expoToken).toBe("test-expo-token-register");
  });

  test("POST /notifications/register validates request body (missing fields)", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: testDeviceId,
          expoToken: "test-expo-token-register",
          pushToken: "test-push-token-register",
        }),
      },
    );
    expect(response.status).toBe(400);
    const data = (await response.json()) as { errors: unknown };
    expect(data.errors).toBeDefined();
  });

  test("POST /notifications/register returns 403 if device not owned by authenticated user", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "current",
          deviceId: "wrong-device-id",
          expoToken: "test-expo-token-forbidden",
          pushToken: "test-push-token-forbidden",
          installations: [
            {
              identityId: testIdentityId,
              xmtpInstallationId: "test-installation-id-register",
            },
          ],
        } satisfies RegisterInstallationRequestBody),
      },
    );
    expect(response.status).toBe(403);
  });

  test("DELETE /notifications/unregister/:xmtpInstallationId deletes an installation", async () => {
    const xmtpInstallationIdToTest = "test-installation-id-unregister-setup";
    const regResponse = await fetch(
      "http://localhost:3008/notifications/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "current",
          deviceId: testDeviceId,
          expoToken: "token-for-unregister",
          pushToken: "token-for-unregister-push",
          installations: [
            {
              identityId: testIdentityId,
              xmtpInstallationId: xmtpInstallationIdToTest,
            },
          ],
        } satisfies RegisterInstallationRequestBody),
      },
    );

    expect(regResponse.status).toBe(201);

    const unregResponse = await fetch(
      `http://localhost:3008/notifications/unregister/${xmtpInstallationIdToTest}`,
      {
        method: "DELETE",
      },
    );
    expect(unregResponse.status).toBe(200);

    const iod = await prisma.identitiesOnDevice.findUnique({
      where: {
        deviceId_identityId: {
          deviceId: testDeviceId,
          identityId: testIdentityId,
        },
      },
    });
    expect(iod?.xmtpInstallationId).toBeNull();
  });
});

describe("/notifications API - Subscribe/Unsubscribe (No local DB auth needed, using XMTP installationId)", () => {
  test("POST /notifications/subscribe handles simple topic subscription", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/subscribe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installationId: genericTestInstallationId1,
          topics: ["test-topic-1", "test-topic-2"],
        }),
      },
    );
    expect(response.status).toBe(200);
  });

  test("POST /notifications/subscribe handles subscription with metadata", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/subscribe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installationId: genericTestInstallationId2,
          subscriptions: [
            {
              topic: "test-topic-1",
              isSilent: true,
              hmacKeys: [
                {
                  thirtyDayPeriodsSinceEpoch: 1,
                  key: uint8ArrayToHex(new Uint8Array([1, 2, 3])),
                },
              ],
            },
            {
              topic: "test-topic-2",
              isSilent: false,
              hmacKeys: [
                {
                  thirtyDayPeriodsSinceEpoch: 1,
                  key: uint8ArrayToHex(new Uint8Array([1, 2, 3])),
                },
              ],
            },
          ],
        }),
      },
    );
    expect(response.status).toBe(200);
  });

  test("POST /notifications/unsubscribe removes topic subscriptions", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/unsubscribe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installationId: genericTestInstallationId3,
          topics: ["test-topic-1", "test-topic-2"],
        }),
      },
    );
    expect(response.status).toBe(200);
  });

  test("POST /notifications/subscribe validates request body for missing installationId", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/subscribe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topics: ["test-topic"] }),
      },
    );
    expect(response.status).toBe(400);
    const data = (await response.json()) as {
      errors?: unknown;
      error?: string;
    };
    expect(data.errors ?? data.error).toBeDefined();
  });

  test("POST /notifications/unsubscribe validates request body for missing topics", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/unsubscribe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId: genericTestInstallationId4 }),
      },
    );
    expect(response.status).toBe(400);
    const data = (await response.json()) as {
      errors?: unknown;
      error?: string;
    };
    expect(data.errors ?? data.error).toBeDefined();
  });
});
