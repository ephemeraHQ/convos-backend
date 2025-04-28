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
app.use("/users", usersRouter);

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
    const createUserBody: CreateUserRequestBody = {
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
        username: "test-user",
      },
    };

    const response = await fetch("http://localhost:3001/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });

    expect(response.status).toBe(201);

    const user = (await response.json()) as CreatedReturnedUser;
    expect(user.privyUserId).toBe(createUserBody.privyUserId);
    expect(user.id).toBeDefined();
    expect(user.device.id).toBeDefined();
    expect(user.device.os).toBe(createUserBody.device.os);
    expect(user.device.name!).toBe(createUserBody.device.name!);
    expect(user.identity.id).toBeDefined();
    expect(user.identity.privyAddress).toBe(
      createUserBody.identity.privyAddress,
    );
    expect(user.identity.xmtpId).toBe(createUserBody.identity.xmtpId);
    expect(user.profile.name).toBe(createUserBody.profile.name);
  });

  test("GET /users/me returns 401 without auth header", async () => {
    const response = await fetch("http://localhost:3001/users/me");
    const data = (await response.json()) as { error: string };
    expect(response.status).toBe(404);
    expect(data.error).toBe("User not found");
  });

  test("GET /users/me returns current user", async () => {
    // First create a user
    const createUserBody: CreateUserRequestBody = {
      privyUserId: "test-privy-user-id",
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
        username: "test-user",
      },
    };

    const createResponse = await fetch("http://localhost:3001/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-privy-user-id",
      },
      body: JSON.stringify(createUserBody),
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
