import type { Server } from "http";
import { DeviceOS, InviteCodeStatus } from "@prisma/client";
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
  CreateInviteCodeRequestBody,
  CreateInviteCodeResponse,
} from "@/api/v1/invites/handlers/create-invite-code";
import invitesRouter from "@/api/v1/invites/invites.router";
import type { CreatedReturnedUser } from "@/api/v1/users/handlers/create-user";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);

const AUTH_USER_XMTP_ID = "test-invite-xmtp-id";

// Add middleware to simulate authentication for tests
app.use((req, res, next) => {
  // Set xmtpId for testing - this simulates the auth middleware
  req.app.locals.xmtpId = AUTH_USER_XMTP_ID;
  next();
});

app.use("/invites", invitesRouter);

let server: Server;

beforeAll(() => {
  // start the server on a test port
  server = app.listen(3010);
});

afterAll(async () => {
  // disconnect from the database
  await prisma.$disconnect();
  // close the server
  server.close();
});

beforeEach(async () => {
  // clean up the database before each test
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

// Helper function to create a test user with DeviceIdentity
async function createTestUser(suffix = "") {
  // Create user first
  const user = await prisma.user.create({
    data: {
      turnkeyUserId: `test-invites-turnkey-user-id${suffix}`,
    },
  });

  // Create DeviceIdentity directly
  const deviceIdentity = await prisma.deviceIdentity.create({
    data: {
      userId: user.id,
      xmtpId: AUTH_USER_XMTP_ID,
      turnkeyAddress: `test-turnkey-address${suffix}`,
      profile: {
        create: {
          name: `Test User${suffix}`,
          username: `test-user${suffix}`,
          description: "Test bio",
        },
      },
    },
    include: {
      profile: true,
    },
  });

  // Create device
  const device = await prisma.device.create({
    data: {
      userId: user.id,
      os: DeviceOS.ios,
      name: "Test Initial Device",
    },
  });

  // Link device and identity
  await prisma.identitiesOnDevice.create({
    data: {
      deviceId: device.id,
      identityId: deviceIdentity.id,
      xmtpInstallationId: `test-installation-id${suffix}`,
    },
  });

  return {
    id: user.id,
    turnkeyUserId: user.turnkeyUserId,
    device: {
      id: device.id,
      os: device.os,
      name: device.name,
    },
    identity: {
      id: deviceIdentity.id,
      turnkeyAddress: deviceIdentity.turnkeyAddress,
      xmtpId: deviceIdentity.xmtpId,
    },
    profile: {
      id: deviceIdentity.profile!.id,
      name: deviceIdentity.profile!.name,
      username: deviceIdentity.profile!.username,
      description: deviceIdentity.profile!.description,
      avatar: deviceIdentity.profile!.avatar,
    },
  } as CreatedReturnedUser;
}

describe("/invites API", () => {
  test("server is running", async () => {
    const response = await fetch("http://localhost:3010/users");
    console.log("Server test response:", response.status);
    expect(response.status).toBeDefined();
  });

  test("POST /invites creates a new invite code with minimal data", async () => {
    // Create test user first
    await createTestUser();

    const createInviteBody = {
      groupId: "test-group-id",
    };

    const response = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createInviteBody),
    });

    if (response.status !== 201) {
      console.log("Response status:", response.status);
      const body = await response.text();
      console.log("Response body:", body);

      // Also check if the route is even being registered
      const routeTestResponse = await fetch("http://localhost:3010/invites", {
        method: "GET",
      });
      console.log("GET route test status:", routeTestResponse.status);
    }
    expect(response.status).toBe(201);

    const inviteCode = (await response.json()) as CreateInviteCodeResponse;
    expect(inviteCode.id).toBeDefined();
    expect(inviteCode.groupId).toBe("test-group-id");
    expect(inviteCode.name).toBe(null);
    expect(inviteCode.description).toBe(null);
    expect(inviteCode.imageUrl).toBe(null);
    expect(inviteCode.maxUses).toBe(null);
    expect(inviteCode.usesCount).toBe(0);
    expect(inviteCode.status).toBe(InviteCodeStatus.ACTIVE);
    expect(inviteCode.expiresAt).toBe(null);
    expect(inviteCode.autoApprove).toBe(false);
    expect(inviteCode.createdAt).toBeDefined();
  });

  test("POST /invites creates a new invite code with all optional fields", async () => {
    // Create test user first
    await createTestUser("-full");

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
    const createInviteBody: CreateInviteCodeRequestBody = {
      groupId: "test-group-id-full",
      name: "Test Group Invite",
      description: "This is a test group invite",
      imageUrl: "https://example.com/image.jpg",
      maxUses: 50,
      expiresAt: expiresAt.toISOString(),
      autoApprove: true,
    };

    const response = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createInviteBody),
    });

    expect(response.status).toBe(201);

    const inviteCode = (await response.json()) as CreateInviteCodeResponse;
    expect(inviteCode.id).toBeDefined();
    expect(inviteCode.groupId).toBe("test-group-id-full");
    expect(inviteCode.name).toBe("Test Group Invite");
    expect(inviteCode.description).toBe("This is a test group invite");
    expect(inviteCode.imageUrl).toBe("https://example.com/image.jpg");
    expect(inviteCode.maxUses).toBe(50);
    expect(inviteCode.usesCount).toBe(0);
    expect(inviteCode.status).toBe(InviteCodeStatus.ACTIVE);
    expect(inviteCode.expiresAt).toBe(expiresAt.toISOString());
    expect(inviteCode.autoApprove).toBe(true);
    expect(inviteCode.createdAt).toBeDefined();
  });

  test("POST /invites validates required fields", async () => {
    // Create test user first
    await createTestUser("-validation");

    const response = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test Group Invite",
        // Missing required groupId
      }),
    });

    expect(response.status).toBe(400);

    const error = (await response.json()) as {
      success: boolean;
      message: string;
      errors: unknown;
    };
    expect(error.success).toBe(false);
    expect(error.message).toBe("Invalid request body");
    expect(error.errors).toBeDefined();
  });

  test("POST /invites validates imageUrl format", async () => {
    // Create test user first
    await createTestUser("-image-validation");

    const createInviteBody = {
      groupId: "test-group-id",
      imageUrl: "not-a-valid-url",
    };

    const response = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createInviteBody),
    });

    expect(response.status).toBe(400);

    const error = (await response.json()) as {
      success: boolean;
      message: string;
      errors: unknown;
    };
    expect(error.success).toBe(false);
    expect(error.message).toBe("Invalid request body");
    expect(error.errors).toBeDefined();
  });

  test("POST /invites validates maxUses is positive", async () => {
    // Create test user first
    await createTestUser("-max-uses-validation");

    const createInviteBody = {
      groupId: "test-group-id",
      maxUses: -1,
    };

    const response = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createInviteBody),
    });

    expect(response.status).toBe(400);

    const error = (await response.json()) as {
      success: boolean;
      message: string;
      errors: unknown;
    };
    expect(error.success).toBe(false);
    expect(error.message).toBe("Invalid request body");
    expect(error.errors).toBeDefined();
  });

  test("POST /invites validates expiresAt is valid datetime", async () => {
    // Create test user first
    await createTestUser("-expires-validation");

    const createInviteBody = {
      groupId: "test-group-id",
      expiresAt: "not-a-valid-date",
    };

    const response = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createInviteBody),
    });

    expect(response.status).toBe(400);

    const error = (await response.json()) as {
      success: boolean;
      message: string;
      errors: unknown;
    };
    expect(error.success).toBe(false);
    expect(error.message).toBe("Invalid request body");
    expect(error.errors).toBeDefined();
  });

  test("POST /invites returns 404 when identity not found", async () => {
    // Don't create a user, so identity won't be found
    const createInviteBody = {
      groupId: "test-group-id",
    };

    const response = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createInviteBody),
    });

    expect(response.status).toBe(404);

    const error = (await response.json()) as {
      success: boolean;
      message: string;
    };
    expect(error.success).toBe(false);
    expect(error.message).toBe("Identity not found");
  });

  test("POST /invites creates invite code with cuid as ID", async () => {
    // Create test user first
    await createTestUser("-cuid-test");

    const createInviteBody = {
      groupId: "test-group-id",
    };

    const response = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createInviteBody),
    });

    expect(response.status).toBe(201);

    const inviteCode = (await response.json()) as CreateInviteCodeResponse;
    // CUID should be 25 characters long and start with 'c'
    expect(inviteCode.id).toMatch(/^c[a-z0-9]{24}$/);
  });

  test("POST /invites stores correct createdById", async () => {
    // Create test user first
    await createTestUser("-created-by-test");

    const createInviteBody = {
      groupId: "test-group-id",
    };

    const response = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createInviteBody),
    });

    expect(response.status).toBe(201);

    const inviteCode = (await response.json()) as CreateInviteCodeResponse;

    // Verify the invite code was created with correct createdById
    const dbInviteCode = await prisma.inviteCode.findUnique({
      where: { id: inviteCode.id },
      include: { createdBy: true },
    });

    expect(dbInviteCode?.createdBy.xmtpId).toBe(AUTH_USER_XMTP_ID);
  });

  test("POST /invites handles default values correctly", async () => {
    // Create test user first
    await createTestUser("-defaults-test");

    const createInviteBody = {
      groupId: "test-group-id",
      // Not setting autoApprove to test default value
    };

    const response = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createInviteBody),
    });

    expect(response.status).toBe(201);

    const inviteCode = (await response.json()) as CreateInviteCodeResponse;
    expect(inviteCode.autoApprove).toBe(false); // Default value
    expect(inviteCode.status).toBe(InviteCodeStatus.ACTIVE); // Default value
    expect(inviteCode.usesCount).toBe(0); // Default value
  });
});
