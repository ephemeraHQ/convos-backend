import type { Server } from "http";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import { uint8ArrayToHex } from "uint8array-extras";
import notificationsRouter from "@/api/v1/notifications";
import { jsonMiddleware } from "@/middleware/json";
import { createNotificationClient } from "@/notifications/client";
import type { RegisterInstallationResponse } from "@/notifications/gen/notifications/v1/service_pb";

const app = express();
app.use(jsonMiddleware);
app.use("/notifications", notificationsRouter);

let server: Server;

const testInstallationId = "test-installation-id";
const notificationClient = createNotificationClient();

beforeAll(() => {
  server = app.listen(3008);
});

afterAll(() => {
  server.close();
});

afterEach(async () => {
  await notificationClient.deleteInstallation({
    installationId: testInstallationId,
  });
});

describe("/notifications API", () => {
  test("POST /notifications/register creates a new installation", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/register",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          installationId: testInstallationId,
          deliveryMechanism: {
            deliveryMechanismType: {
              case: "apnsDeviceToken",
              value: "test-device-token",
            },
          },
        }),
      },
    );

    expect(response.status).toBe(201);
    const data = (await response.json()) as RegisterInstallationResponse;
    expect(data).toBeDefined();
    expect(data.installationId).toBe(testInstallationId);
    expect(data.validUntil).toBeGreaterThan(0);
  });

  test("POST /notifications/register validates request body", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/register",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          installationId: testInstallationId,
          // Missing required deliveryMechanism
        }),
      },
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe("Invalid request body");
  });

  test("POST /notifications/subscribe handles simple topic subscription", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/subscribe",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          installationId: testInstallationId,
          topics: ["test-topic-1", "test-topic-2"],
        }),
      },
    );

    expect(response.status).toBe(200);
  });

  test.only("POST /notifications/subscribe handles subscription with metadata", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/subscribe",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          installationId: testInstallationId,
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
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          installationId: testInstallationId,
          topics: ["test-topic-1", "test-topic-2"],
        }),
      },
    );

    expect(response.status).toBe(200);
  });

  test("DELETE /notifications/unregister/:installationId deletes an installation", async () => {
    const response = await fetch(
      `http://localhost:3008/notifications/unregister/${testInstallationId}`,
      {
        method: "DELETE",
      },
    );

    expect(response.status).toBe(200);
  });

  test("POST /notifications/subscribe validates request body", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/subscribe",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Missing required installationId
          topics: ["test-topic"],
        }),
      },
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe("Invalid request body");
  });

  test("POST /notifications/unsubscribe validates request body", async () => {
    const response = await fetch(
      "http://localhost:3008/notifications/unsubscribe",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          installationId: testInstallationId,
          // Missing required topics array
        }),
      },
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe("Invalid request body");
  });
});
