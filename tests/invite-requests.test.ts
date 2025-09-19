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
import type { DeleteRequestToJoinResponse } from "@/api/v1/invites/handlers/delete-request-to-join";
import type { GetInviteRequestsResponse } from "@/api/v1/invites/handlers/get-invite-requests";
import type {
  RequestToJoinRequestBody,
  RequestToJoinResponse,
} from "@/api/v1/invites/handlers/request-to-join";
import invitesRouter from "@/api/v1/invites/invites.router";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);

// Mock authentication by setting the request locals with optional override
app.use((req, _res, next) => {
  const overrideXmtpId = req.headers["x-test-xmtp-id"];
  _res.locals.xmtpId =
    typeof overrideXmtpId === "string"
      ? overrideXmtpId
      : "test-xmtp-id-requester";
  _res.locals.xmtpInstallationId = "test-installation-id";
  next();
});

app.use("/invites", invitesRouter);

let server: Server;

beforeAll(() => {
  server = app.listen(3011);
});

afterAll(async () => {
  server.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Clean up the database before each test
  await prisma.inviteCodeNotificationTarget.deleteMany();
  await prisma.inviteCodeRequest.deleteMany();
  await prisma.inviteCodeUse.deleteMany();
  await prisma.inviteCode.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.identitiesOnDevice.deleteMany();
  await prisma.deviceIdentity.deleteMany();
  await prisma.device.deleteMany();
});

async function createTestUsers() {
  // Create invite creator identity
  const creatorIdentity = await prisma.deviceIdentity.create({
    data: {
      xmtpId: "test-creator-xmtp-id",
      identityAddress: "0x1234creator",
    },
  });
  const creatorDevice = await prisma.device.create({
    data: { id: "test-device-id-creator", os: DeviceOS.ios },
  });
  await prisma.identitiesOnDevice.create({
    data: { deviceId: creatorDevice.id, identityId: creatorIdentity.id },
  });

  // Create requester identity used in some tests
  const requesterIdentity = await prisma.deviceIdentity.create({
    data: {
      xmtpId: "test-xmtp-id-requester",
      identityAddress: "0x1234requester",
    },
  });
  const requesterDevice = await prisma.device.create({
    data: { id: "test-device-id-requester", os: DeviceOS.android },
  });
  await prisma.identitiesOnDevice.create({
    data: { deviceId: requesterDevice.id, identityId: requesterIdentity.id },
  });

  return { creatorIdentity, requesterIdentity };
}

async function createTestInviteCode(args: { autoApprove?: boolean } = {}) {
  await createTestUsers();

  const creatorIdentity = await prisma.deviceIdentity.findFirst({
    where: { xmtpId: "test-creator-xmtp-id" },
  });

  // Create group metadata first
  await prisma.groupMetadata.upsert({
    where: { id: "test-group-123" },
    update: {},
    create: {
      id: "test-group-123",
      name: "Test Group Invite",
    },
  });

  return await prisma.inviteCode.create({
    data: {
      groupId: "test-group-123",
      autoApprove: args.autoApprove ?? false, // Default to requiring approval
      createdById: creatorIdentity!.id,
    },
  });
}

interface ErrorResponse {
  success: boolean;
  message: string;
}

describe("/invites/request API", () => {
  test("server is running", async () => {
    const response = await fetch("http://localhost:3011/invites");
    expect(response.status).toBeDefined();
  });

  test("POST /invites/request creates a new join request", async () => {
    const inviteCode = await createTestInviteCode();

    const requestBody: RequestToJoinRequestBody = {
      inviteId: inviteCode.id,
    };

    const response = await fetch("http://localhost:3011/invites/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(201);

    const joinRequest = (await response.json()) as RequestToJoinResponse;
    expect(joinRequest.id).toBeDefined();
    expect(joinRequest.invite.id).toBe(inviteCode.id);
    expect(joinRequest.createdAt).toBeDefined();

    // Verify the request was created in the database
    const dbRequest = await prisma.inviteCodeRequest.findUnique({
      where: { id: joinRequest.id },
    });
    expect(dbRequest).toBeTruthy();
  });

  test("POST /invites/request rejects duplicate request", async () => {
    const inviteCode = await createTestInviteCode();
    const requesterIdentity = await prisma.deviceIdentity.findFirst({
      where: { xmtpId: "test-xmtp-id-requester" },
    });

    // Create an existing request
    await prisma.inviteCodeRequest.create({
      data: {
        inviteCodeId: inviteCode.id,
        requesterId: requesterIdentity!.id,
      },
    });

    const requestBody: RequestToJoinRequestBody = {
      inviteId: inviteCode.id,
    };

    const response = await fetch("http://localhost:3011/invites/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(409);

    const error = (await response.json()) as ErrorResponse;
    expect(error.success).toBe(false);
    expect(error.message).toContain("already have a request");
  });

  test("POST /invites/request returns 404 for non-existent invite", async () => {
    await createTestUsers();

    const requestBody: RequestToJoinRequestBody = {
      inviteId: "non-existent-invite-id",
    };

    const response = await fetch("http://localhost:3011/invites/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(404);

    const error = (await response.json()) as ErrorResponse;
    expect(error.success).toBe(false);
    expect(error.message).toBe("Invite not found");
  });

  test("POST /invites/request returns 404 for identity not found", async () => {
    // Don't create the requester, so identity won't be found
    const inviteCode = await createTestInviteCode();

    // Override the mock authentication to use a non-existent xmtpId
    const testApp = express();
    testApp.use(pinoMiddleware);
    testApp.use(jsonMiddleware);
    testApp.use((req, _res, next) => {
      _res.locals.xmtpId = "non-existent-xmtp-id";
      next();
    });
    testApp.use("/invites", invitesRouter);

    const testServer = testApp.listen(3012);

    try {
      const requestBody: RequestToJoinRequestBody = {
        inviteId: inviteCode.id,
      };

      const response = await fetch("http://localhost:3012/invites/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBe(404);

      const error = (await response.json()) as ErrorResponse;
      expect(error.success).toBe(false);
      expect(error.message).toBe("Identity not found");
    } finally {
      testServer.close();
    }
  });

  test("DELETE /invites/requests/:requestId allows requester to delete and creator sees it removed", async () => {
    // Arrange: create creator/requester and invite code
    const inviteCode = await createTestInviteCode();

    // Act: requester creates a join request
    const createReqRes = await fetch("http://localhost:3011/invites/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-xmtp-id": "test-xmtp-id-requester",
      },
      body: JSON.stringify({ inviteId: inviteCode.id }),
    });
    expect(createReqRes.status).toBe(201);
    const joinRequest = (await createReqRes.json()) as RequestToJoinResponse;

    // Assert: creator sees 1 request
    const listBeforeRes = await fetch(
      "http://localhost:3011/invites/requests",
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-test-xmtp-id": "test-creator-xmtp-id",
        },
      },
    );
    expect(listBeforeRes.status).toBe(200);
    const listBefore =
      (await listBeforeRes.json()) as GetInviteRequestsResponse;
    expect(listBefore.total).toBe(1);
    expect(listBefore.requests[0].id).toBe(joinRequest.id);

    // Act: requester deletes their request
    const deleteRes = await fetch(
      `http://localhost:3011/invites/requests/${joinRequest.id}`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-test-xmtp-id": "test-xmtp-id-requester",
        },
      },
    );
    expect(deleteRes.status).toBe(200);
    const deleted = (await deleteRes.json()) as DeleteRequestToJoinResponse;
    expect(deleted.id).toBe(joinRequest.id);
    expect(deleted.deleted).toBe(true);

    // Assert: creator sees 0 requests now
    const listAfterRes = await fetch("http://localhost:3011/invites/requests", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-test-xmtp-id": "test-creator-xmtp-id",
      },
    });
    expect(listAfterRes.status).toBe(200);
    const listAfter = (await listAfterRes.json()) as GetInviteRequestsResponse;
    expect(listAfter.total).toBe(0);
  });

  test("DELETE /invites/requests/:requestId allows invite creator to delete", async () => {
    const inviteCode = await createTestInviteCode();

    const createReqRes = await fetch("http://localhost:3011/invites/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-xmtp-id": "test-xmtp-id-requester",
      },
      body: JSON.stringify({ inviteId: inviteCode.id }),
    });
    expect(createReqRes.status).toBe(201);
    const joinRequest = (await createReqRes.json()) as RequestToJoinResponse;

    const deleteRes = await fetch(
      `http://localhost:3011/invites/requests/${joinRequest.id}`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-test-xmtp-id": "test-creator-xmtp-id",
        },
      },
    );
    expect(deleteRes.status).toBe(200);
    const deleted = (await deleteRes.json()) as DeleteRequestToJoinResponse;
    expect(deleted.id).toBe(joinRequest.id);
    expect(deleted.deleted).toBe(true);

    // creator sees 0 requests now
    const listAfterRes = await fetch("http://localhost:3011/invites/requests", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-test-xmtp-id": "test-creator-xmtp-id",
      },
    });
    expect(listAfterRes.status).toBe(200);
    const listAfter = (await listAfterRes.json()) as GetInviteRequestsResponse;
    expect(listAfter.total).toBe(0);
  });

  test("DELETE /invites/requests/:requestId allows notification target to delete", async () => {
    const inviteCode = await createTestInviteCode();

    // Create a notification target identity and link it to the invite
    const notifier = await prisma.deviceIdentity.create({
      data: { xmtpId: "test-notifier-xmtp-id" },
    });
    await prisma.inviteCodeNotificationTarget.create({
      data: {
        inviteCodeId: inviteCode.id,
        deviceIdentityId: notifier.id,
      },
    });

    const createReqRes = await fetch("http://localhost:3011/invites/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-xmtp-id": "test-xmtp-id-requester",
      },
      body: JSON.stringify({ inviteId: inviteCode.id }),
    });
    expect(createReqRes.status).toBe(201);
    const joinRequest = (await createReqRes.json()) as RequestToJoinResponse;

    const deleteRes = await fetch(
      `http://localhost:3011/invites/requests/${joinRequest.id}`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-test-xmtp-id": "test-notifier-xmtp-id",
        },
      },
    );
    expect(deleteRes.status).toBe(200);
    const deleted = (await deleteRes.json()) as DeleteRequestToJoinResponse;
    expect(deleted.id).toBe(joinRequest.id);
    expect(deleted.deleted).toBe(true);

    const listAfterRes = await fetch("http://localhost:3011/invites/requests", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-test-xmtp-id": "test-creator-xmtp-id",
      },
    });
    expect(listAfterRes.status).toBe(200);
    const listAfter = (await listAfterRes.json()) as GetInviteRequestsResponse;
    expect(listAfter.total).toBe(0);
  });

  test("DELETE /invites/requests/:requestId by non-requester fails", async () => {
    // Arrange: create creator/requester and invite code
    const inviteCode = await createTestInviteCode();

    // Ensure we also have a third identity
    await prisma.deviceIdentity.create({
      data: { xmtpId: "test-user3-xmtp-id" },
    });

    // Act: requester creates a join request
    const createReqRes = await fetch("http://localhost:3011/invites/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-xmtp-id": "test-xmtp-id-requester",
      },
      body: JSON.stringify({ inviteId: inviteCode.id }),
    });
    expect(createReqRes.status).toBe(201);
    const joinRequest = (await createReqRes.json()) as RequestToJoinResponse;

    // Act: user3 attempts to delete the request
    const deleteRes = await fetch(
      `http://localhost:3011/invites/requests/${joinRequest.id}`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-test-xmtp-id": "test-user3-xmtp-id",
        },
      },
    );
    expect(deleteRes.status).toBe(404);
    const error = (await deleteRes.json()) as {
      success: boolean;
      message: string;
    };
    expect(error.success).toBe(false);
    expect(error.message).toBe("Request to join not found");

    // Assert: creator still sees 1 request
    const listRes = await fetch("http://localhost:3011/invites/requests", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-test-xmtp-id": "test-creator-xmtp-id",
      },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as GetInviteRequestsResponse;
    expect(list.total).toBe(1);
    expect(list.requests[0].id).toBe(joinRequest.id);
  });
});
