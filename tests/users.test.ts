import type { Server } from "http";
import { DeviceOS, PrismaClient } from "@prisma/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import usersRouter from "@/api/v1/users";
import type {
  CreatedReturnedUser,
  ReturnedCurrentUser,
} from "@/api/v1/users/users.types";
import { jsonMiddleware } from "@/middleware/json";

const app = express();
app.use(jsonMiddleware);
app.use("/users", usersRouter);

const prisma = new PrismaClient();
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
  await prisma.conversationMetadata.deleteMany();
  await prisma.deviceIdentity.deleteMany();
  await prisma.device.deleteMany();
  await prisma.user.deleteMany();
});

describe("/users API", () => {
  test("POST /users creates a new user", async () => {
    const response = await fetch("http://localhost:3001/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-users-privy-user-id",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address",
          xmtpId: "test-xmtp-id",
        },
        profile: {
          name: "Test User",
        },
      }),
    });

    expect(response.status).toBe(201);

    const user = (await response.json()) as CreatedReturnedUser;
    expect(user.privyUserId).toBe("test-users-privy-user-id");
    expect(user.id).toBeDefined();
    expect(user.device.id).toBeDefined();
    expect(user.device.os).toBe(DeviceOS.ios);
    expect(user.device.name).toBe("iPhone 14");
    expect(user.identity.id).toBeDefined();
    expect(user.identity.privyAddress).toBe("test-privy-address");
    expect(user.identity.xmtpId).toBe("test-xmtp-id");
    expect(user.profile?.name).toBe("Test User");
  });

  test("GET /users/me returns 401 without auth header", async () => {
    const response = await fetch("http://localhost:3001/users/me");
    const data = (await response.json()) as { error: string };
    expect(response.status).toBe(404);
    expect(data.error).toBe("User not found");
  });

  test("GET /users/me returns current user", async () => {
    // First create a user
    const createResponse = await fetch("http://localhost:3001/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-privy-user-id",
      },
      body: JSON.stringify({
        privyUserId: "test-privy-user-id",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address",
          xmtpId: "test-xmtp-id",
        },
      }),
    });
    expect(createResponse.status).toBe(201);

    // Then try to get /me with auth header
    const response = await fetch("http://localhost:3001/users/me", {
      headers: {
        Authorization: "Bearer test-privy-user-id",
      },
    });

    expect(response.status).toBe(200);

    const user = (await response.json()) as ReturnedCurrentUser;
    expect(user.id).toBeDefined();
    expect(user.identities).toHaveLength(1);
    expect(user.identities[0].privyAddress).toBe("test-privy-address");
    expect(user.identities[0].xmtpId).toBe("test-xmtp-id");
  });
});
