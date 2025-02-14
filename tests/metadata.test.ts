import type { Server } from "http";
import {
  DeviceOS,
  PrismaClient,
  type ConversationMetadata,
} from "@prisma/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import metadataRouter from "@/api/v1/metadata";
import usersRouter, { type ReturnedUser } from "@/api/v1/users";
import { jsonMiddleware } from "@/middleware/json";

const app = express();
app.use(jsonMiddleware);
app.use("/users", usersRouter);
app.use("/metadata", metadataRouter);

const prisma = new PrismaClient();
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
  test("GET /metadata/conversation/:conversationId returns 404 for non-existent metadata", async () => {
    const response = await fetch(
      "http://localhost:3005/metadata/conversation/nonexistent-id",
    );
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(data.error).toBe("Conversation metadata not found");
  });

  test("POST /metadata/conversation/:deviceIdentityId creates new metadata", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3005/users", {
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
    const createdUser = (await createUserResponse.json()) as ReturnedUser;

    const response = await fetch(
      `http://localhost:3005/metadata/conversation/${createdUser.identity.id}`,
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

  test("POST /metadata/conversation/:deviceIdentityId returns 404 for non-existent device", async () => {
    const response = await fetch(
      "http://localhost:3005/metadata/conversation/nonexistent-id",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          conversationId: "test-conversation-id",
          pinned: true,
        }),
      },
    );
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(data.error).toBe("Device identity not found");
  });

  test("GET /metadata/conversation/:conversationId returns metadata when exists", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3005/users", {
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
    const createdUser = (await createUserResponse.json()) as ReturnedUser;

    // Create metadata
    const createMetadataResponse = await fetch(
      `http://localhost:3005/metadata/conversation/${createdUser.identity.id}`,
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
        }),
      },
    );

    const createdMetadata =
      (await createMetadataResponse.json()) as ConversationMetadata;

    const response = await fetch(
      `http://localhost:3005/metadata/conversation/${createdMetadata.conversationId}`,
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

  test("PUT /metadata/conversation/:conversationId updates metadata", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3005/users", {
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
    const createdUser = (await createUserResponse.json()) as ReturnedUser;

    // Create metadata
    const createMetadataResponse = await fetch(
      `http://localhost:3005/metadata/conversation/${createdUser.identity.id}`,
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
        }),
      },
    );

    const createdMetadata =
      (await createMetadataResponse.json()) as ConversationMetadata;

    const response = await fetch(
      `http://localhost:3005/metadata/conversation/${createdMetadata.conversationId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pinned: false,
          unread: true,
          deleted: true,
        }),
      },
    );
    const updatedMetadata = (await response.json()) as ConversationMetadata;

    expect(response.status).toBe(200);
    expect(updatedMetadata.conversationId).toBe("test-conversation-id");
    expect(updatedMetadata.pinned).toBe(false);
    expect(updatedMetadata.unread).toBe(true);
    expect(updatedMetadata.deleted).toBe(true);
  });

  test("PUT /metadata/conversation/:conversationId returns 400 for invalid data", async () => {
    const response = await fetch(
      "http://localhost:3005/metadata/conversation/test-id",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pinned: "not-a-boolean",
        }),
      },
    );
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe("Invalid request body");
  });
});
