import type { Server } from "http";
import { DeviceOS, PrismaClient, type User } from "@prisma/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import usersRouter, { type CreatedUser } from "@/api/v1/users";
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
  await prisma.identitiesOnDevice.deleteMany();
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
    const user = (await response.json()) as CreatedUser;

    expect(response.status).toBe(201);
    expect(user.privyUserId).toBe("test-privy-user-id");
    expect(user.id).toBeDefined();
    expect(user.device.id).toBeDefined();
    expect(user.device.os).toBe(DeviceOS.ios);
    expect(user.device.name).toBe("iPhone 14");
    expect(user.identity.id).toBeDefined();
    expect(user.identity.privyAddress).toBe("test-privy-address");
    expect(user.identity.xmtpId).toBe("test-xmtp-id");
  });

  test("GET /users/:id returns 404 for non-existent user", async () => {
    const response = await fetch("http://localhost:3001/users/nonexistent-id");
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(data.error).toBe("User not found");
  });

  test("GET /users/:id returns user when exists", async () => {
    // create a user
    const createResponse = await fetch("http://localhost:3001/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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
    const createdUser = (await createResponse.json()) as CreatedUser;

    // fetch the user
    const response = await fetch(
      `http://localhost:3001/users/${createdUser.id}`,
    );
    const user = (await response.json()) as User;

    expect(response.status).toBe(200);
    expect(user.id).toBe(createdUser.id);
    expect(user.privyUserId).toBe("test-privy-user-id");
  });

  test("PUT /users/:id updates user", async () => {
    // create a user
    const createResponse = await fetch("http://localhost:3001/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "old-privy-user-id",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "old-privy-address",
          xmtpId: "old-xmtp-id",
        },
      }),
    });
    const createdUser = (await createResponse.json()) as CreatedUser;

    // update the user
    const updateResponse = await fetch(
      `http://localhost:3001/users/${createdUser.id}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          privyUserId: "new-privy-user-id",
        }),
      },
    );
    const updatedUser = (await updateResponse.json()) as User;

    expect(updateResponse.status).toBe(200);
    expect(updatedUser.id).toBe(createdUser.id);
    expect(updatedUser.privyUserId).toBe("new-privy-user-id");
  });
});
