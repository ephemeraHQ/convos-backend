import type { Server } from "http";
import { DeviceOS, type ConversationMetadata } from "@prisma/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import metadataRouter from "@/api/v1/metadata/metadata.router";
import type {
  CreatedReturnedUser,
  CreateUserRequestBody,
} from "@/api/v1/users/handlers/create-user";
import usersRouter from "@/api/v1/users/users.router";
import { jsonMiddleware } from "@/middleware/json";
import { prisma } from "@/utils/prisma";

const app = express();
app.use(jsonMiddleware);

const AUTH_XMTP_ID = "test-xmtp-id";

// Add middleware to simulate authentication for tests
app.use((req, res, next) => {
  // Set xmtpId for testing - this simulates the auth middleware
  req.app.locals.xmtpId = AUTH_XMTP_ID;
  next();
});

app.use("/users", usersRouter);
app.use("/metadata", metadataRouter);

let server: Server;

beforeAll(() => {
  server = app.listen(3005);
});

afterAll(async () => {
  await prisma.$disconnect();
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

describe("/metadata API", () => {
  test("GET /metadata/conversation/:deviceIdentityId/:conversationId returns 403 for unauthorized access", async () => {
    const response = await fetch(
      "http://localhost:3005/metadata/conversation/nonexistent-id/nonexistent-convo-id",
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Not authorized to access this device identity",
    });
  });

  test("POST /metadata/conversation creates new metadata", async () => {
    // Create a user first with profile
    const createUserBody: CreateUserRequestBody = {
      turnkeyUserId: "test-metadata-turnkey-user-id",
      device: {
        os: DeviceOS.ios,
        name: "iPhone 14",
      },
      identity: {
        turnkeyAddress: "test-turnkey-address",
        xmtpId: AUTH_XMTP_ID,
      },
      profile: {
        name: "Test User",
        username: "test-user",
        description: "Test bio",
        avatar: "https://example.com/avatar.jpg",
      },
    };

    const createUserResponse = await fetch("http://localhost:3005/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    const response = await fetch(
      "http://localhost:3005/metadata/conversation",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          conversationId: "test-conversation-id",
          pinned: true,
          unread: true,
          deleted: false,
          readUntil: new Date().toISOString(),
          deviceIdentityId: createdUser.identity.id,
        }),
      },
    );
    const metadata = (await response.json()) as ConversationMetadata;

    expect(response.status).toBe(201);
    expect(metadata.conversationId).toBe("test-conversation-id");
    expect(metadata.deviceIdentityId).toBe(createdUser.identity.id);
    expect(metadata.pinned).toBe(true);
    expect(metadata.unread).toBe(true);
    expect(metadata.deleted).toBe(false);
  });

  test("POST /metadata/conversation returns 403 for non-existent device", async () => {
    const response = await fetch(
      "http://localhost:3005/metadata/conversation",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          conversationId: "test-conversation-id",
          pinned: true,
          unread: false,
          deleted: false,
          readUntil: new Date().toISOString(),
          deviceIdentityId: "nonexistent-id",
        }),
      },
    );
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(data.error).toBe("Not authorized to access this device identity");
  });

  test("GET /metadata/conversation/:deviceIdentityId/:conversationId returns metadata when exists", async () => {
    // Create a user first
    const createUserBody: CreateUserRequestBody = {
      turnkeyUserId: "test-metadata-turnkey-user-id",
      device: {
        os: DeviceOS.ios,
        name: "iPhone 14",
      },
      identity: {
        turnkeyAddress: "test-turnkey-address",
        xmtpId: AUTH_XMTP_ID,
      },
      profile: {
        name: "Test User 2",
        username: "test-user-2",
        description: "Test bio 2",
        avatar: "https://example.com/avatar2.jpg",
      },
    };

    const createUserResponse = await fetch("http://localhost:3005/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    // Create metadata
    const createMetadataResponse = await fetch(
      "http://localhost:3005/metadata/conversation",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          conversationId: "test-conversation-id",
          pinned: true,
          unread: false,
          deleted: false,
          readUntil: new Date().toISOString(),
          deviceIdentityId: createdUser.identity.id,
        }),
      },
    );

    const createdMetadata =
      (await createMetadataResponse.json()) as ConversationMetadata;

    // Get the metadata
    const response = await fetch(
      `http://localhost:3005/metadata/conversation/${createdUser.identity.id}/${createdMetadata.conversationId}`,
    );

    const metadata = (await response.json()) as ConversationMetadata;

    expect(response.status).toBe(200);
    expect(metadata.conversationId).toBe("test-conversation-id");
    expect(metadata.pinned).toBe(true);
    expect(metadata.unread).toBe(false);
    expect(metadata.deleted).toBe(false);
    expect(metadata.readUntil).toBe(createdMetadata.readUntil);
    expect(metadata.deviceIdentityId).toBe(createdUser.identity.id);
  });

  test("POST /metadata/conversation updates existing metadata", async () => {
    // Create a user first
    const createUserBody: CreateUserRequestBody = {
      turnkeyUserId: "test-metadata-turnkey-user-id",
      device: {
        os: DeviceOS.ios,
        name: "iPhone 14",
      },
      identity: {
        turnkeyAddress: "test-turnkey-address",
        xmtpId: AUTH_XMTP_ID,
      },
      profile: {
        name: "Test User 3",
        username: "test-user-3",
        description: "Test bio 3",
        avatar: "https://example.com/avatar3.jpg",
      },
    };

    const createUserResponse = await fetch("http://localhost:3005/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    // Update the metadata with new values
    const updateResponse = await fetch(
      "http://localhost:3005/metadata/conversation",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          conversationId: "test-conversation-id",
          pinned: false,
          unread: true,
          deleted: true,
          deviceIdentityId: createdUser.identity.id,
        }),
      },
    );
    const updatedMetadata =
      (await updateResponse.json()) as ConversationMetadata;

    expect(updateResponse.status).toBe(201);
    expect(updatedMetadata.conversationId).toBe("test-conversation-id");
    expect(updatedMetadata.pinned).toBe(false);
    expect(updatedMetadata.unread).toBe(true);
    expect(updatedMetadata.deleted).toBe(true);
    expect(updatedMetadata.deviceIdentityId).toBe(createdUser.identity.id);
  });
});
