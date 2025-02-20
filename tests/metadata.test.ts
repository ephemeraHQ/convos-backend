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
import type { CreatedReturnedUser } from "@/api/v1/users/handlers/create-user";
import usersRouter from "@/api/v1/users/users.router";
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

  test("POST /metadata/conversation creates new metadata", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3005/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-metadata-privy-user-id",
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

  test("POST /metadata/conversation returns 404 for non-existent device", async () => {
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
        privyUserId: "test-metadata-privy-user-id",
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

  test("POST /metadata/conversation updates existing metadata", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3005/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-metadata-privy-user-id",
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
