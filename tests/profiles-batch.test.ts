import type { Server } from "http";
import type { DeviceIdentity, Profile } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import profilesRouter from "@/api/v1/profiles/profiles.router";
import type { BatchProfilesResponse } from "@/api/v1/profiles/profiles.types";
import { jsonMiddleware } from "@/middleware/json";
import { prisma } from "@/utils/prisma";

const app = express();
app.use(jsonMiddleware);

// Add type declaration to augment Request type
declare module "express-serve-static-core" {
  interface Request {
    auth?: {
      userId: string;
    };
  }
}

// Mock auth middleware for tests
app.use((req, res, next) => {
  req.auth = {
    userId: "test-user-id",
  };
  next();
});

// Register routes
app.use("/profiles", profilesRouter);

let server: Server;
let baseUrl: string;

describe("Batch Profile endpoints", () => {
  const testProfiles: (Profile & { deviceIdentity: DeviceIdentity })[] = [];
  const xmtpIds = ["test-xmtp-id-1", "test-xmtp-id-2", "test-xmtp-id-3"];
  const testUserId = "test-user-id-batch-profiles";

  beforeAll(async () => {
    // Wait a bit in CI environments
    if (process.env.CI) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Your existing setup but with better error handling
    try {
      // Create test user
      const testUser = await prisma.user.create({
        data: {
          id: testUserId,
          turnkeyUserId: "test-turnkey-user-id-batch-profiles",
        },
      });

      server = app.listen(0);

      // Wait for server to be ready
      await new Promise((resolve, reject) => {
        server.on("listening", resolve);
        server.on("error", reject);
        setTimeout(() => {
          reject(new Error("Server start timeout"));
        }, 5000);
      });

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not get server port");
      }
      baseUrl = `http://localhost:${address.port}`;

      // Create test device identities and profiles
      for (let i = 0; i < xmtpIds.length; i++) {
        const deviceIdentity = await prisma.deviceIdentity.create({
          data: {
            xmtpId: xmtpIds[i],
            turnkeyAddress: `0x${i}123456789`,
            userId: testUser.id,
          },
        });

        const profile = await prisma.profile.create({
          data: {
            name: `Test User ${i}`,
            username: `testuser${i}`,
            description: `Test description ${i}`,
            avatar: `https://example.com/avatar${i}.png`,
            deviceIdentityId: deviceIdentity.id,
          },
          include: {
            deviceIdentity: true,
          },
        });

        testProfiles.push(profile);
      }
    } catch (error) {
      console.error("Test setup failed:", error);
      throw error;
    }
  });

  afterAll(async () => {
    // Clean up test data
    for (const profile of testProfiles) {
      await prisma.profile.delete({
        where: { id: profile.id },
      });

      await prisma.deviceIdentity.delete({
        where: { id: profile.deviceIdentityId },
      });
    }

    // Delete test user
    await prisma.user.delete({
      where: { id: testUserId },
    });

    server.close();
  });

  test("POST /profiles/batch should return profiles for valid xmtpIds", async () => {
    const response = await fetch(`${baseUrl}/profiles/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        xmtpIds: [xmtpIds[0], xmtpIds[1], "non-existent-id"],
      }),
    });

    expect(response.status).toBe(200);

    const body = (await response.json()) as BatchProfilesResponse;
    expect(body.profiles).toBeDefined();

    // Should only return profiles for existing IDs
    expect(Object.keys(body.profiles).length).toBe(2);

    // Verify profile data
    expect(body.profiles[xmtpIds[0]]).toBeDefined();
    expect(body.profiles[xmtpIds[0]].name).toBe("Test User 0");
    expect(body.profiles[xmtpIds[0]].username).toBe("testuser0");

    expect(body.profiles[xmtpIds[1]]).toBeDefined();
    expect(body.profiles[xmtpIds[1]].name).toBe("Test User 1");
    expect(body.profiles[xmtpIds[1]].username).toBe("testuser1");

    // Non-existent ID should not be in the response
    expect(body.profiles["non-existent-id"]).toBeUndefined();
  });

  test("POST /profiles/batch should return 400 for invalid requests", async () => {
    // Empty array
    const emptyResponse = await fetch(`${baseUrl}/profiles/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ xmtpIds: [] }),
    });

    expect(emptyResponse.status).toBe(400);

    // Missing xmtpIds
    const missingResponse = await fetch(`${baseUrl}/profiles/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(missingResponse.status).toBe(400);

    // Too many IDs (mocking the validation)
    const tooManyIdsArray = Array(1001).fill("id");
    const tooManyResponse = await fetch(`${baseUrl}/profiles/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ xmtpIds: tooManyIdsArray }),
    });

    expect(tooManyResponse.status).toBe(400);
  });
});
