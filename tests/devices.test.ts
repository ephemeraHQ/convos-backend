import type { Server } from "http";
import { DeviceOS, PrismaClient, type Device } from "@prisma/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import devicesRouter from "@/api/v1/devices";
import { jsonMiddleware } from "@/middleware/json";

const app = express();
app.use(jsonMiddleware);
app.use("/devices", devicesRouter);

const prisma = new PrismaClient();
let server: Server;

beforeAll(() => {
  // start the server on a test port
  server = app.listen(3002);
});

afterAll(async () => {
  // disconnect from the database
  await prisma.$disconnect();
  // close the server
  server.close();
});

beforeEach(async () => {
  // clean up the database before each test
  await prisma.profile.deleteMany();
  await prisma.identitiesOnDevice.deleteMany();
  await prisma.conversationMetadata.deleteMany();
  await prisma.deviceIdentity.deleteMany();
  await prisma.device.deleteMany();
  await prisma.user.deleteMany();
});

describe("/devices API", () => {
  test("POST /devices/:userId creates a new device", async () => {
    // Create test user first
    const userId = "test-user-id";
    await prisma.user.create({
      data: {
        id: userId,
        privyUserId: "test-devices-privy-user-id",
      },
    });

    const response = await fetch(`http://localhost:3002/devices/${userId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test Device",
        os: DeviceOS.ios,
        pushToken: "test-push-token",
      }),
    });

    const device = (await response.json()) as Device;

    expect(response.status).toBe(201);
    expect(device.name).toBe("Test Device");
    expect(device.os).toBe(DeviceOS.ios);
    expect(device.pushToken).toBe("test-push-token");
    expect(device.userId).toBe(userId);
    expect(device.id).toBeDefined();
  });

  test("GET /devices/:userId/:deviceId returns 404 for non-existent device", async () => {
    // Create test user first
    const userId = "test-user-id";
    await prisma.user.create({
      data: {
        id: userId,
        privyUserId: "test-devices-privy-user-id",
      },
    });

    const response = await fetch(
      `http://localhost:3002/devices/${userId}/nonexistent-id`,
    );
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(data.error).toBe("Device not found");
  });

  test("GET /devices/:userId/:deviceId returns device when exists", async () => {
    // Create test user first
    const userId = "test-user-id";
    await prisma.user.create({
      data: {
        id: userId,
        privyUserId: "test-devices-privy-user-id",
      },
    });

    // create a device
    const createResponse = await fetch(
      `http://localhost:3002/devices/${userId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Device",
          os: DeviceOS.android,
          pushToken: "test-push-token",
        }),
      },
    );
    const createdDevice = (await createResponse.json()) as Device;

    // fetch the device
    const response = await fetch(
      `http://localhost:3002/devices/${userId}/${createdDevice.id}`,
    );
    const device = (await response.json()) as Device;

    expect(response.status).toBe(200);
    expect(device.id).toBe(createdDevice.id);
    expect(device.name).toBe("Test Device");
    expect(device.os).toBe(DeviceOS.android);
    expect(device.pushToken).toBe("test-push-token");
  });

  test("GET /devices/:userId returns all devices for a user", async () => {
    // Create test user first
    const userId = "test-user-id";
    await prisma.user.create({
      data: {
        id: userId,
        privyUserId: "test-devices-privy-user-id",
      },
    });

    // create two devices
    await fetch(`http://localhost:3002/devices/${userId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Device 1",
        os: DeviceOS.ios,
      }),
    });
    await fetch(`http://localhost:3002/devices/${userId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Device 2",
        os: DeviceOS.android,
      }),
    });

    // fetch all devices
    const response = await fetch(`http://localhost:3002/devices/${userId}`);
    const devices = (await response.json()) as Device[];

    expect(response.status).toBe(200);
    expect(devices).toHaveLength(2);
    expect(devices.map((d) => d.name)).toContain("Device 1");
    expect(devices.map((d) => d.name)).toContain("Device 2");
  });

  test("PUT /devices/:userId/:deviceId updates device", async () => {
    // Create test user first
    const userId = "test-user-id";
    await prisma.user.create({
      data: {
        id: userId,
        privyUserId: "test-devices-privy-user-id",
      },
    });

    // create a device
    const createResponse = await fetch(
      `http://localhost:3002/devices/${userId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Old Name",
          os: DeviceOS.ios,
          pushToken: "old-token",
        }),
      },
    );
    const createdDevice = (await createResponse.json()) as Device;

    // update the device
    const updateResponse = await fetch(
      `http://localhost:3002/devices/${userId}/${createdDevice.id}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "New Name",
          os: DeviceOS.android,
          pushToken: "new-token",
        }),
      },
    );
    const updatedDevice = (await updateResponse.json()) as Device;

    expect(updateResponse.status).toBe(200);
    expect(updatedDevice.id).toBe(createdDevice.id);
    expect(updatedDevice.name).toBe("New Name");
    expect(updatedDevice.os).toBe(DeviceOS.android);
    expect(updatedDevice.pushToken).toBe("new-token");
  });

  test("POST /devices/:userId validates request body", async () => {
    // Create test user first
    const userId = "test-user-id";
    await prisma.user.create({
      data: {
        id: userId,
        privyUserId: "test-devices-privy-user-id",
      },
    });

    const response = await fetch(`http://localhost:3002/devices/${userId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test Device",
        os: "INVALID_OS", // Invalid OS value
      }),
    });
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe("Invalid request body");
  });
});
