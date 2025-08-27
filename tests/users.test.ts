import type { Server } from "http";
import { DeviceOS } from "@prisma/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import type {
  CreatedReturnedUser,
  CreateUserRequestBody,
} from "@/api/v1/users/handlers/create-user";
import type { ReturnedCurrentUser } from "@/api/v1/users/handlers/get-current-user";
import usersRouter from "@/api/v1/users/users.router";
import { jsonMiddleware } from "@/middleware/json";
import { prisma } from "@/utils/prisma";

const app = express();
app.use(jsonMiddleware);
app.use("/init", usersRouter);

let server: Server;

beforeAll(() => {
  // start the server on a test port
  server = app.listen(3001);
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
  await prisma.deviceIdentity.deleteMany();
  await prisma.device.deleteMany();
});

describe("/init API", () => {
  test("POST /init creates a new user", async () => {
    const createUserBody: CreateUserRequestBody = {
      device: {
        id: "test-device-id",
        os: DeviceOS.ios,
        name: "iPhone 14",
      },
      identity: {
        identityAddress: "test-turnkey-address",
        xmtpId: "test-xmtp-id",
        xmtpInstallationId: "test-xmtp-installation-id",
      },
      profile: {
        name: "Test User",
        username: "test-user",
      },
    };

    const response = await fetch("http://localhost:3001/init", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });

    expect(response.status).toBe(201);

    const user = (await response.json()) as CreatedReturnedUser;
    expect(user.device.id).toBeDefined();
    expect(user.device.os).toBe(createUserBody.device.os);
    expect(user.device.name!).toBe(createUserBody.device.name!);
    expect(user.identity.id).toBeDefined();
    expect(user.identity.identityAddress).toBe(
      createUserBody.identity.identityAddress || null,
    );
    expect(user.identity.xmtpId).toBe(createUserBody.identity.xmtpId);
    expect(user.profile.name).toBe(createUserBody.profile.name ?? null);
  });

  test("GET /init/me returns 404 without auth header", async () => {
    const response = await fetch("http://localhost:3001/init/me");
    const data = (await response.json()) as { error: string };
    expect(response.status).toBe(404);
    expect(data.error).toBe("Identity not found");
  });

  test("GET /init/me returns current user", async () => {
    // First create a user
    const createUserBody: CreateUserRequestBody = {
      device: {
        id: "test-device-id",
        os: DeviceOS.ios,
        name: "iPhone 14",
      },
      identity: {
        identityAddress: "test-turnkey-address",
        xmtpId: "test-xmtp-id",
        xmtpInstallationId: "test-xmtp-installation-id",
      },
      profile: {
        name: "Test User",
        username: "test-user",
      },
    };

    const createResponse = await fetch("http://localhost:3001/init", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-turnkey-user-id",
      },
      body: JSON.stringify(createUserBody),
    });
    expect(createResponse.status).toBe(201);

    // Then try to get /me with auth header
    const response = await fetch("http://localhost:3001/init/me", {
      headers: {
        Authorization: "Bearer test-turnkey-user-id",
      },
    });

    expect(response.status).toBe(200);

    const user = (await response.json()) as ReturnedCurrentUser;
    expect(user.identities).toHaveLength(1);
    expect(user.identities[0].identityAddress).toBe("test-turnkey-address");
    expect(user.identities[0].xmtpId).toBe("test-xmtp-id");
  });

  test("POST /init can create two users with different devices", async () => {
    const createUser1Body: CreateUserRequestBody = {
      device: {
        id: "test-device-id",
        os: DeviceOS.ios,
        name: "iPhone 14",
      },
      identity: {
        identityAddress: "test-turnkey-address",
        xmtpId: "test-xmtp-id",
        xmtpInstallationId: "test-xmtp-installation-id",
      },
      profile: {
        name: "Test User",
        username: "test-user",
      },
    };

    const response1 = await fetch("http://localhost:3001/init", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUser1Body),
    });

    expect(response1.status).toBe(201);

    const createUser2Body: CreateUserRequestBody = {
      device: {
        id: "test-device-id-2",
        os: DeviceOS.ios,
        name: "iPhone 14",
      },
      identity: {
        identityAddress: "test-turnkey-address-2",
        xmtpId: "test-xmtp-id-2",
        xmtpInstallationId: "test-xmtp-installation-id-2",
      },
      profile: {
        name: "Test User 2",
        username: "test-user-2",
      },
    };

    const response2 = await fetch("http://localhost:3001/init", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUser2Body),
    });

    expect(response2.status).toBe(201);
  });

  test("POST /init can create two users with same device", async () => {
    const sameDeviceId = "test-device-id";
    const createUser1Body: CreateUserRequestBody = {
      device: {
        id: sameDeviceId,
        os: DeviceOS.ios,
        name: "iPhone 14",
      },
      identity: {
        identityAddress: "test-turnkey-address",
        xmtpId: "test-xmtp-id",
        xmtpInstallationId: "test-xmtp-installation-id",
      },
      profile: {
        name: "Test User",
        username: "test-user",
      },
    };

    const response1 = await fetch("http://localhost:3001/init", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUser1Body),
    });

    expect(response1.status).toBe(201);

    const createUser2Body: CreateUserRequestBody = {
      device: {
        id: sameDeviceId,
        os: DeviceOS.ios,
        name: "iPhone 14",
      },
      identity: {
        identityAddress: "test-turnkey-address-2",
        xmtpId: "test-xmtp-id-2",
        xmtpInstallationId: "test-xmtp-installation-id-2",
      },
      profile: {
        name: "Test User 2",
        username: "test-user-2",
      },
    };

    const response2 = await fetch("http://localhost:3001/init", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUser2Body),
    });

    expect(response2.status).toBe(201);
  });
});
