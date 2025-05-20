import type { Server } from "http";
import { DeviceOS, type Device } from "@prisma/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import devicesRouter from "@/api/v1/devices/devices.router";
import type {
  CreatedReturnedUser,
  CreateUserRequestBody,
} from "@/api/v1/users/handlers/create-user";
import usersRouter from "@/api/v1/users/users.router";
import { jsonMiddleware } from "@/middleware/json";
import { prisma } from "@/utils/prisma";

// Constants used throughout tests
const AUTH_XMTP_ID = "test-xmtp-id";

const app = express();
app.use(jsonMiddleware);

// Add middleware to simulate authentication for tests
app.use((req, res, next) => {
  // Set xmtpId for testing - this simulates the auth middleware
  req.app.locals.xmtpId = AUTH_XMTP_ID;
  next();
});

app.use("/users", usersRouter);
app.use("/devices", devicesRouter);

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
    // Create test user first via API
    const createUserBody: CreateUserRequestBody = {
      turnkeyUserId: "test-devices-turnkey-user-id",
      device: {
        os: DeviceOS.ios,
        name: "Test Initial Device",
      },
      identity: {
        turnkeyAddress: "test-turnkey-address",
        xmtpId: AUTH_XMTP_ID,
      },
      profile: {
        name: "Test User",
        username: "test-user",
        description: "Test bio",
      },
    };

    const createUserResponse = await fetch("http://localhost:3002/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;
    const userId = createdUser.id;

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
    // Create test user first via API
    const createUserBody: CreateUserRequestBody = {
      turnkeyUserId: "test-devices-turnkey-user-id-2",
      device: {
        os: DeviceOS.ios,
        name: "Test Initial Device",
      },
      identity: {
        turnkeyAddress: "test-turnkey-address-2",
        xmtpId: AUTH_XMTP_ID,
      },
      profile: {
        name: "Test User 2",
        username: "test-user-2",
        description: "Test bio 2",
      },
    };

    const createUserResponse = await fetch("http://localhost:3002/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;
    const userId = createdUser.id;

    const response = await fetch(
      `http://localhost:3002/devices/${userId}/nonexistent-id`,
    );
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(data.error).toBe("Device not found");
  });

  test("GET /devices/:userId/:deviceId returns device when exists", async () => {
    // Create test user first via API
    const createUserBody: CreateUserRequestBody = {
      turnkeyUserId: "test-devices-turnkey-user-id-3",
      device: {
        os: DeviceOS.ios,
        name: "Test Initial Device",
      },
      identity: {
        turnkeyAddress: "test-turnkey-address-3",
        xmtpId: AUTH_XMTP_ID,
      },
      profile: {
        name: "Test User 3",
        username: "test-user-3",
        description: "Test bio 3",
      },
    };

    const createUserResponse = await fetch("http://localhost:3002/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;
    const userId = createdUser.id;

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
    // Create test user first via API
    const createUserBody: CreateUserRequestBody = {
      turnkeyUserId: "test-devices-turnkey-user-id-4",
      device: {
        os: DeviceOS.ios,
        name: "Test Initial Device",
      },
      identity: {
        turnkeyAddress: "test-turnkey-address-4",
        xmtpId: AUTH_XMTP_ID,
      },
      profile: {
        name: "Test User 4",
        username: "test-user-4",
        description: "Test bio 4",
      },
    };

    const createUserResponse = await fetch("http://localhost:3002/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;
    const userId = createdUser.id;

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
    expect(devices).toHaveLength(3);
    expect(devices.map((d) => d.name)).toContain("Device 1");
    expect(devices.map((d) => d.name)).toContain("Device 2");
    expect(devices.map((d) => d.name)).toContain("Test Initial Device");
  });

  test("PUT /devices/:userId/:deviceId updates device", async () => {
    // Create test user first via API
    const createUserBody: CreateUserRequestBody = {
      turnkeyUserId: "test-devices-turnkey-user-id-5",
      device: {
        os: DeviceOS.ios,
        name: "Test Initial Device",
      },
      identity: {
        turnkeyAddress: "test-turnkey-address-5",
        xmtpId: AUTH_XMTP_ID,
      },
      profile: {
        name: "Test User 5",
        username: "test-user-5",
        description: "Test bio 5",
      },
    };

    const createUserResponse = await fetch("http://localhost:3002/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;
    const userId = createdUser.id;

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
    // Create test user first via API
    const createUserBody: CreateUserRequestBody = {
      turnkeyUserId: "test-devices-turnkey-user-id-6",
      device: {
        os: DeviceOS.ios,
        name: "Test Initial Device",
      },
      identity: {
        turnkeyAddress: "test-turnkey-address-6",
        xmtpId: AUTH_XMTP_ID,
      },
      profile: {
        name: "Test User 6",
        username: "test-user-6",
        description: "Test bio 6",
      },
    };

    const createUserResponse = await fetch("http://localhost:3002/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;
    const userId = createdUser.id;

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
