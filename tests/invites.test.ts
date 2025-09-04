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
import type { InitResponse } from "@/api/v1/init/handlers/init";
import type {
  CreateInviteCodeRequestBody,
  CreateInviteCodeResponse,
} from "@/api/v1/invites/handlers/create-invite-code";
import type { GetInviteDetailsResponse } from "@/api/v1/invites/handlers/get-invite-details";
import invitesRouter from "@/api/v1/invites/invites.router";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);

const AUTH_USER_XMTP_ID = "test-invite-xmtp-id";

// Add middleware to simulate authentication for tests
app.use((req, res, next) => {
  const overrideXmtpId = req.headers["x-test-xmtp-id"];
  res.locals.xmtpId =
    typeof overrideXmtpId === "string" ? overrideXmtpId : AUTH_USER_XMTP_ID;
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
  await prisma.deviceIdentity.deleteMany();
  await prisma.device.deleteMany();
});

// Helper function to create a test user with DeviceIdentity
async function createTestUser(suffix = "", xmtpId = AUTH_USER_XMTP_ID) {
  // Create DeviceIdentity directly
  const deviceIdentity = await prisma.deviceIdentity.create({
    data: {
      xmtpId,
      identityAddress: `test-turnkey-address${suffix}`,
      profile: {
        create: {
          name: `Test User${suffix}`,
          username: `test-user${suffix.replace(/-/g, "")}`,
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
      id: `test-device-id${suffix}`,
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
    device: {
      id: device.id,
      os: device.os,
      name: device.name,
    },
    identity: {
      id: deviceIdentity.id,
      identityAddress: deviceIdentity.identityAddress,
      xmtpId: deviceIdentity.xmtpId,
    },
    profile: {
      id: deviceIdentity.profile!.id,
      name: deviceIdentity.profile!.name,
      username: deviceIdentity.profile!.username,
      description: deviceIdentity.profile!.description,
      avatar: deviceIdentity.profile!.avatar,
    },
  } as InitResponse;
}

describe("/invites API", () => {
  test("server is running", async () => {
    const response = await fetch("http://localhost:3010/invites");
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
    expect(inviteCode.inviteLinkURL).toBeDefined();
    expect(inviteCode.inviteLinkURL).toMatch(/^.*\/join\/c[a-z0-9]{24}$/);
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
      notificationTargets: [],
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
    expect(inviteCode.inviteLinkURL).toBeDefined();
    expect(inviteCode.inviteLinkURL).toMatch(/^.*\/join\/c[a-z0-9]{24}$/);
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
    expect(inviteCode.inviteLinkURL).toBeDefined();
    expect(inviteCode.inviteLinkURL).toMatch(/^.*\/join\/c[a-z0-9]{24}$/);
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
    expect(inviteCode.inviteLinkURL).toBeDefined();
    expect(inviteCode.inviteLinkURL).toMatch(/^.*\/join\/c[a-z0-9]{24}$/);
  });

  test("POST /invites/:inviteId updates existing invite code", async () => {
    // Create test user first
    await createTestUser("-update-test");

    // First create an invite
    const createBody = {
      groupId: "test-group-update",
      name: "Original Name",
      description: "Original Description",
      autoApprove: false,
    };

    const createResponse = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createBody),
    });

    expect(createResponse.status).toBe(201);
    const originalInvite =
      (await createResponse.json()) as CreateInviteCodeResponse;

    // Now update the invite
    const updateBody = {
      groupId: "test-group-update",
      name: "Updated Name",
      description: "Updated Description",
      autoApprove: true,
      status: InviteCodeStatus.DISABLED,
    };

    const updateResponse = await fetch(
      `http://localhost:3010/invites/${originalInvite.id}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updateBody),
      },
    );

    expect(updateResponse.status).toBe(200);
    const updatedInvite =
      (await updateResponse.json()) as CreateInviteCodeResponse;

    // Verify the update
    expect(updatedInvite.id).toBe(originalInvite.id); // Same ID
    expect(updatedInvite.name).toBe("Updated Name");
    expect(updatedInvite.description).toBe("Updated Description");
    expect(updatedInvite.autoApprove).toBe(true);
    expect(updatedInvite.inviteLinkURL).toBe(originalInvite.inviteLinkURL); // Same URL
    expect(updatedInvite.status).toBe(InviteCodeStatus.DISABLED);
  });

  test("POST /invites/:inviteId returns 404 for non-existent invite", async () => {
    // Create test user first
    await createTestUser("-update-404-test");

    const updateBody = {
      groupId: "test-group-404",
      name: "Test Name",
    };

    const response = await fetch(
      "http://localhost:3010/invites/non-existent-id",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updateBody),
      },
    );

    expect(response.status).toBe(404);
    const error = (await response.json()) as {
      success: boolean;
      message: string;
    };
    expect(error.success).toBe(false);
    expect(error.message).toBe("Invite not found");
  });

  test("DELETE /invites/:inviteId deletes the invite (creator only)", async () => {
    // Create creator user and invite
    await createTestUser("-delete-invite-owner");

    const createRes = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "group-to-delete", name: "To Delete" }),
    });
    expect(createRes.status).toBe(201);
    const invite = (await createRes.json()) as CreateInviteCodeResponse;

    // Fetch details (200)
    const getBefore = await fetch(
      `http://localhost:3010/invites/${invite.id}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(getBefore.status).toBe(200);

    // Delete as creator
    const delRes = await fetch(`http://localhost:3010/invites/${invite.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    expect(delRes.status).toBe(200);
    const del = (await delRes.json()) as { id: string; deleted: boolean };
    expect(del.id).toBe(invite.id);
    expect(del.deleted).toBe(true);

    // Fetch again (404)
    const getAfter = await fetch(`http://localhost:3010/invites/${invite.id}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    expect(getAfter.status).toBe(404);
  });

  test("DELETE /invites/:inviteId by non-creator is forbidden", async () => {
    // Create creator and invite
    await createTestUser("-delete-invite-owner2");
    const createRes = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: "group-to-delete2",
        name: "To Delete 2",
      }),
    });
    expect(createRes.status).toBe(201);
    const invite = (await createRes.json()) as CreateInviteCodeResponse;

    // Create another user
    const OTHER_XMTP_ID = "delete-invite-other-user";
    await createTestUser("-delete-invite-other", OTHER_XMTP_ID);

    // Attempt delete as non-creator
    const delRes = await fetch(`http://localhost:3010/invites/${invite.id}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "x-test-xmtp-id": OTHER_XMTP_ID,
      },
    });
    expect(delRes.status).toBe(403);
    const err = (await delRes.json()) as { success: boolean; message: string };
    expect(err.success).toBe(false);
    expect(err.message).toBe("Not authorized to delete this invite");

    // Ensure invite still exists (creator can fetch)
    const getRes = await fetch(`http://localhost:3010/invites/${invite.id}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    expect(getRes.status).toBe(200);
  });

  test("POST /invites/:inviteId returns 403 for unauthorized update", async () => {
    // Create first user and invite
    await createTestUser("-owner");
    const createBody = {
      groupId: "test-group-auth",
      name: "Owner's Invite",
    };

    const createResponse = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createBody),
    });

    expect(createResponse.status).toBe(201);
    const invite = (await createResponse.json()) as CreateInviteCodeResponse;

    // Create second user who shouldn't be able to update
    const secondUserApp = express();
    secondUserApp.use(pinoMiddleware);
    secondUserApp.use(jsonMiddleware);
    secondUserApp.use((req, _res, next) => {
      _res.locals.xmtpId = "different-user-xmtp-id";
      _res.locals.xmtpInstallationId = "different-installation-id";
      next();
    });
    secondUserApp.use("/invites", invitesRouter);
    const secondServer = secondUserApp.listen(3013);

    try {
      // Create the second user in the database
      await createTestUser("-unauthorized", "different-user-xmtp-id");

      const updateBody = {
        groupId: "test-group-auth",
        name: "Hacked Name",
      };

      const response = await fetch(
        `http://localhost:3013/invites/${invite.id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updateBody),
        },
      );

      expect(response.status).toBe(403);
      const error = (await response.json()) as {
        success: boolean;
        message: string;
      };
      expect(error.success).toBe(false);
      expect(error.message).toBe("Not authorized to update this invite");
    } finally {
      secondServer.close();
    }
  });

  test("GET /invites/:inviteId returns full details for invite creator", async () => {
    // Create test user first
    await createTestUser("-get-details-owner");

    // Create an invite
    const createBody = {
      groupId: "test-group-get-details",
      name: "Test Get Details",
      description: "Test description",
      maxUses: 10,
      autoApprove: true,
    };

    const createResponse = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createBody),
    });

    expect(createResponse.status).toBe(201);
    const invite = (await createResponse.json()) as CreateInviteCodeResponse;

    // Get invite details as the creator
    const getResponse = await fetch(
      `http://localhost:3010/invites/${invite.id}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    expect(getResponse.status).toBe(200);
    const details = (await getResponse.json()) as GetInviteDetailsResponse;

    // Should return full details since this is the creator
    expect(details.id).toBe(invite.id);
    expect(details.name).toBe("Test Get Details");
    expect(details.description).toBe("Test description");
    expect(details.maxUses).toBe(10);
    expect(details.usesCount).toBe(0);
    expect(details.status).toBe(InviteCodeStatus.ACTIVE);
    expect(details.autoApprove).toBe(true);
    expect(details.groupId).toBe("test-group-get-details");
    expect(details.createdAt).toBeDefined();
    expect(details.inviteLinkURL).toBeDefined();
  });

  test("GET /invites/:inviteId returns 403 for non-creator", async () => {
    // Create first user and invite
    await createTestUser("-get-details-creator");
    const createBody = {
      groupId: "test-group-get-auth",
      name: "Creator's Invite",
      description: "Only creator should see this",
    };

    const createResponse = await fetch("http://localhost:3010/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createBody),
    });

    expect(createResponse.status).toBe(201);
    const invite = (await createResponse.json()) as CreateInviteCodeResponse;

    // Create second user who shouldn't be able to view details
    const secondUserApp = express();
    secondUserApp.use(pinoMiddleware);
    secondUserApp.use(jsonMiddleware);
    secondUserApp.use((req, _res, next) => {
      _res.locals.xmtpId = "different-user-get-details-xmtp-id";
      _res.locals.xmtpInstallationId = "different-installation-id";
      next();
    });
    secondUserApp.use("/invites", invitesRouter);
    const secondServer = secondUserApp.listen(3014);

    try {
      // Create the second user in the database
      await createTestUser(
        "-unauthorized-get",
        "different-user-get-details-xmtp-id",
      );

      const getResponse = await fetch(
        `http://localhost:3014/invites/${invite.id}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      expect(getResponse.status).toBe(403);
      const error = (await getResponse.json()) as {
        success: boolean;
        message: string;
      };
      expect(error.success).toBe(false);
      expect(error.message).toBe(
        "Forbidden: you don't have access to this invite",
      );
    } finally {
      secondServer.close();
    }
  });

  test("GET /invites/:inviteId returns 404 for non-existent invite", async () => {
    // Create test user first
    await createTestUser("-get-404-test");

    const response = await fetch(
      "http://localhost:3010/invites/non-existent-invite-id",
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    expect(response.status).toBe(404);
    const error = (await response.json()) as {
      success: boolean;
      message: string;
    };
    expect(error.success).toBe(false);
    expect(error.message).toBe("Invite not found");
  });

  test("GET /invites/:inviteId returns 404 when user identity not found", async () => {
    // Don't create a user, so identity won't be found
    const response = await fetch(
      "http://localhost:3010/invites/some-invite-id",
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    expect(response.status).toBe(404);
    const error = (await response.json()) as {
      success: boolean;
      message: string;
    };
    expect(error.success).toBe(false);
    expect(error.message).toBe("Identity not found");
  });
});
