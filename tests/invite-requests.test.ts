import type { Server } from "http";
import { DeviceOS, InviteCodeRequestStatus, UserType } from "@prisma/client";
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

// Mock authentication by setting the request locals
app.use((req, _res, next) => {
  req.app.locals.xmtpId = "test-xmtp-id-requester";
  req.app.locals.xmtpInstallationId = "test-installation-id";
  next();
});

app.use("/invites", invitesRouter);

let server: Server;

beforeAll(() => {
  server = app.listen(3011);
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  // Clean up the database before each test
  await prisma.inviteCodeNotificationTarget.deleteMany();
  await prisma.inviteCodeRequest.deleteMany();
  await prisma.inviteCodeUse.deleteMany();
  await prisma.inviteCode.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.identitiesOnDevice.deleteMany();
  await prisma.conversationMetadata.deleteMany();
  await prisma.deviceIdentity.deleteMany();
  await prisma.device.deleteMany();
  await prisma.user.deleteMany();
});

async function createTestUsers() {
  // Create invite creator user
  const creatorUser = await prisma.user.create({
    data: {
      userId: "test-creator-user",
      userType: UserType.turnkey,
      devices: {
        create: {
          device: {
            create: {
              id: "test-device-id-creator",
              os: DeviceOS.ios,
              name: "Test Creator Device",
            },
          },
        },
      },
      DeviceIdentity: {
        create: {
          xmtpId: "test-creator-xmtp-id",
          identityAddress: "0x1234creator",
          profile: {
            create: {
              name: "Test Creator",
              username: "testcreator",
              description: "Test creator user",
            },
          },
        },
      },
    },
  });

  // Create requester user
  const requesterUser = await prisma.user.create({
    data: {
      userId: "test-requester-user",
      userType: UserType.turnkey,
      devices: {
        create: {
          device: {
            create: {
              id: "test-device-id-requester",
              os: DeviceOS.android,
              name: "Test Requester Device",
            },
          },
        },
      },
      DeviceIdentity: {
        create: {
          xmtpId: "test-xmtp-id-requester",
          identityAddress: "0x1234requester",
          profile: {
            create: {
              name: "Test Requester",
              username: "testrequester",
              description: "Test requester user",
            },
          },
        },
      },
    },
  });

  return { creatorUser, requesterUser };
}

async function createTestInviteCode(args: { autoApprove?: boolean } = {}) {
  await createTestUsers();

  const creatorIdentity = await prisma.deviceIdentity.findFirst({
    where: { xmtpId: "test-creator-xmtp-id" },
  });

  return await prisma.inviteCode.create({
    data: {
      groupId: "test-group-123",
      name: "Test Group Invite",
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
    expect(joinRequest.status).toBe("PENDING");
    expect(joinRequest.inviteId).toBe(inviteCode.id);
    expect(joinRequest.createdAt).toBeDefined();

    // Verify the request was created in the database
    const dbRequest = await prisma.inviteCodeRequest.findUnique({
      where: { id: joinRequest.id },
    });
    expect(dbRequest).toBeTruthy();
    expect(dbRequest?.status).toBe(InviteCodeRequestStatus.PENDING);
  });

  test("POST /invites/request rejects request for auto-approve invite", async () => {
    const inviteCode = await createTestInviteCode({ autoApprove: true });

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

    expect(response.status).toBe(400);

    const error = (await response.json()) as ErrorResponse;
    expect(error.success).toBe(false);
    expect(error.message).toContain("does not require approval");
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
        status: "PENDING",
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
    expect(error.message).toContain("already have a pending request");
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
      req.app.locals.xmtpId = "non-existent-xmtp-id";
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
});
