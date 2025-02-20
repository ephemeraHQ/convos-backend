import type { Server } from "http";
import { DeviceOS, PrismaClient, type Profile } from "@prisma/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import type { ProfileValidationResponse } from "@/api/v1/profiles/profile.types";
import profilesRouter from "@/api/v1/profiles/profiles.router";
import type { ProfileRequestResult } from "@/api/v1/profiles/profiles.types";
import usersRouter from "@/api/v1/users";
import type { CreatedReturnedUser } from "@/api/v1/users/users.types";
import { jsonMiddleware } from "@/middleware/json";

const app = express();
app.use(jsonMiddleware);
app.use("/users", usersRouter);
app.use("/profiles", profilesRouter);

const prisma = new PrismaClient();
let server: Server;

beforeAll(() => {
  server = app.listen(3004);
});

afterAll(async () => {
  await prisma.$disconnect();
  server.close();
});

beforeEach(async () => {
  // Clean up the database before each test
  await prisma.profile.deleteMany();
  await prisma.identitiesOnDevice.deleteMany();
  await prisma.conversationMetadata.deleteMany();
  await prisma.deviceIdentity.deleteMany();
  await prisma.device.deleteMany();
  await prisma.user.deleteMany();
});

describe("/profiles API", () => {
  test("GET /profiles/:id returns 404 for non-existent profile", async () => {
    const response = await fetch(
      "http://localhost:3004/profiles/nonexistent-id",
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Profile not found" });
  });

  test("GET /profiles/:id returns profile when exists", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-profiles-privy-user-id",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address",
          xmtpId: "test-xmtp-id",
        },
        profile: {
          name: "Test Profile",
          description: "Test Description",
        },
      }),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    const response = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.xmtpId}`,
    );
    const profile = (await response.json()) as Profile;

    expect(response.status).toBe(200);
    expect(profile.id).toBe(createdUser.profile!.id);
    expect(profile.name).toBe("Test Profile");
    expect(profile.description).toBe("Test Description");
  });

  test("PUT /profiles/:id updates profile", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-profiles-privy-user-id",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address",
          xmtpId: "test-xmtp-id",
        },
        profile: {
          name: "Test Profile",
          description: "Test Description",
        },
      }),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    // Update the profile
    const response = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.xmtpId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Updated Name",
          description: "Updated Description",
        }),
      },
    );

    const updatedProfile = (await response.json()) as Profile;

    expect(response.status).toBe(200);
    expect(updatedProfile.id).toBe(createdUser.profile!.id);
    expect(updatedProfile.name).toBe("Updated Name");
    expect(updatedProfile.description).toBe("Updated Description");
  });

  test("PUT /profiles/:id returns 400 for invalid request body", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-profiles-privy-user-id",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address",
          xmtpId: "test-xmtp-id",
        },
        profile: {
          name: "Test Profile",
          description: "Test Description",
        },
      }),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    const response = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.xmtpId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: 123, // Invalid type for name (should be string)
        }),
      },
    );

    expect(response.status).toBe(400);
    const result = (await response.json()) as ProfileValidationResponse;
    expect(result.success).toBe(false);
    expect(result.errors?.name).toBe("Expected string, received number");
  });

  test("PUT /profiles/:id returns 400 for name too short", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-profiles-privy-user-id-2",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address-2",
          xmtpId: "test-xmtp-id-2",
        },
        profile: {
          name: "Test Profile",
          description: "Test Description",
        },
      }),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    const response = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.xmtpId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "ab", // Too short (minimum 3 characters)
        }),
      },
    );

    expect(response.status).toBe(400);
    const result = (await response.json()) as ProfileValidationResponse;
    expect(result.success).toBe(false);
    expect(result.errors?.name).toBe("Name must be at least 3 characters long");
  });

  test("PUT /profiles/:id returns 400 for name too long", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-profiles-privy-user-id-3",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address-3",
          xmtpId: "test-xmtp-id-3",
        },
        profile: {
          name: "Test Profile",
          description: "Test Description",
        },
      }),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    const response = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.xmtpId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "a".repeat(51), // Too long (maximum 50 characters)
        }),
      },
    );

    expect(response.status).toBe(400);
    const result = (await response.json()) as ProfileValidationResponse;
    expect(result.success).toBe(false);
    expect(result.errors?.name).toBe("Name cannot exceed 50 characters");
  });

  test("PUT /profiles/:id returns 400 for description too long", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-profiles-privy-user-id-4",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address-4",
          xmtpId: "test-xmtp-id-4",
        },
        profile: {
          name: "Test Profile",
          description: "Test Description",
        },
      }),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    const response = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.xmtpId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          description: "a".repeat(501), // Too long (maximum 500 characters)
        }),
      },
    );

    expect(response.status).toBe(400);
    const result = (await response.json()) as ProfileValidationResponse;
    expect(result.success).toBe(false);
    expect(result.errors?.description).toBe(
      "Description cannot exceed 500 characters",
    );
  });

  test("PUT /profiles/:id returns 400 for invalid avatar URL", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-profiles-privy-user-id-5",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address-5",
          xmtpId: "test-xmtp-id-5",
        },
        profile: {
          name: "Test Profile",
          description: "Test Description",
        },
      }),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    const response = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.xmtpId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          avatar: "not-a-valid-url", // Invalid URL format
        }),
      },
    );

    expect(response.status).toBe(400);
    const result = (await response.json()) as ProfileValidationResponse;
    expect(result.success).toBe(false);
    expect(result.errors?.avatar).toBe("Invalid url");
  });

  test("PUT /profiles/:id returns 409 for duplicate username", async () => {
    // Create first user with profile
    const createFirstUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-profiles-privy-user-id-6",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address-6",
          xmtpId: "test-xmtp-id-6",
        },
        profile: {
          name: "Existing Username",
          description: "Test Description",
        },
      }),
    });
    await createFirstUserResponse.json();

    // Create second user with different profile
    const createSecondUserResponse = await fetch(
      "http://localhost:3004/users",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          privyUserId: "test-profiles-privy-user-id-7",
          device: {
            os: DeviceOS.ios,
            name: "iPhone 14",
          },
          identity: {
            privyAddress: "test-privy-address-7",
            xmtpId: "test-xmtp-id-7",
          },
          profile: {
            name: "Original Username",
            description: "Test Description",
          },
        }),
      },
    );
    const secondUser =
      (await createSecondUserResponse.json()) as CreatedReturnedUser;

    // Try to update second user's profile with first user's username
    const response = await fetch(
      `http://localhost:3004/profiles/${secondUser.identity.xmtpId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Existing Username", // Already taken by first user
        }),
      },
    );

    expect(response.status).toBe(409);
    const result = (await response.json()) as ProfileValidationResponse;
    expect(result.success).toBe(false);
    expect(result.errors?.username).toBe("This username is already taken");
  });

  test("GET /profiles/search returns matching profiles", async () => {
    // Create a user with a profile
    await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-profiles-privy-user-id",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address",
          xmtpId: "test-xmtp-id",
        },
        profile: {
          name: "Alice Wonder",
          description: "Test Description",
        },
      }),
    });

    // Search for the profile
    const searchResponse = await fetch(
      "http://localhost:3004/profiles/search?query=Alice",
    );
    const results = (await searchResponse.json()) as ProfileRequestResult[];

    expect(searchResponse.status).toBe(200);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Alice Wonder");
    expect(results[0].description).toBe("Test Description");
    expect(results[0].xmtpId).toBe("test-xmtp-id");
  });

  test("GET /profiles/search is case insensitive", async () => {
    // Create a user with a profile
    await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-profiles-privy-user-id",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address",
          xmtpId: "test-xmtp-id",
        },
        profile: {
          name: "Alice Wonder",
          description: "Test Description",
        },
      }),
    });

    // Search with lowercase
    const searchResponse = await fetch(
      "http://localhost:3004/profiles/search?query=alice",
    );
    const results = (await searchResponse.json()) as ProfileRequestResult[];

    expect(searchResponse.status).toBe(200);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Alice Wonder");
    expect(results[0].description).toBe("Test Description");
    expect(results[0].xmtpId).toBe("test-xmtp-id");
  });

  test("GET /profiles/search returns 400 for empty query", async () => {
    const searchResponse = await fetch(
      "http://localhost:3004/profiles/search?query=",
    );

    expect(searchResponse.status).toBe(400);
    expect(await searchResponse.json()).toEqual({
      error: "Invalid search query",
    });
  });

  test("GET /profiles/search returns empty array when no matches", async () => {
    const searchResponse = await fetch(
      "http://localhost:3004/profiles/search?query=NonexistentName",
    );
    const results = (await searchResponse.json()) as ProfileRequestResult[];

    expect(searchResponse.status).toBe(200);
    expect(results).toHaveLength(0);
  });

  test("PUT /profiles/:id updates profile avatar", async () => {
    // Create a user first with a profile
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-profiles-privy-user-id",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address",
          xmtpId: "test-xmtp-id",
        },
        profile: {
          name: "Test Profile",
          description: "Test Description",
          avatar: "https://example.com/old-avatar.jpg",
        },
      }),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    // Update just the avatar
    const response = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.xmtpId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          avatar: "https://example.com/new-avatar.jpg",
        }),
      },
    );

    const updatedProfile = (await response.json()) as Profile;

    expect(response.status).toBe(200);
    expect(updatedProfile.id).toBe(createdUser.profile!.id);
    expect(updatedProfile.name).toBe("Test Profile"); // unchanged
    expect(updatedProfile.description).toBe("Test Description"); // unchanged
    expect(updatedProfile.avatar).toBe("https://example.com/new-avatar.jpg");
  });

  describe("GET /profiles/check/:username", () => {
    test("returns false for non-existent username", async () => {
      const response = await fetch(
        "http://localhost:3004/profiles/check/nonexistentuser",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ taken: false });
    });

    test("returns true for existing username", async () => {
      // Create a user first
      const createUserResponse = await fetch("http://localhost:3004/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          privyUserId: "test-profiles-privy-user-id",
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

      // Create a profile
      const profile = await prisma.profile.create({
        data: {
          name: "existinguser",
          description: "test description",
          deviceIdentityId: createdUser.identity.id,
        },
      });

      const response = await fetch(
        "http://localhost:3004/profiles/check/existinguser",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ taken: true });

      // Clean up
      await prisma.profile.delete({ where: { id: profile.id } });
    });

    test("is case insensitive", async () => {
      // Create a user first
      const createUserResponse = await fetch("http://localhost:3004/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          privyUserId: "test-profiles-privy-user-id-2",
          device: {
            os: DeviceOS.ios,
            name: "iPhone 14",
          },
          identity: {
            privyAddress: "test-privy-address-2",
            xmtpId: "test-xmtp-id-2",
          },
        }),
      });

      const createdUser =
        (await createUserResponse.json()) as CreatedReturnedUser;

      // Create a profile
      const profile = await prisma.profile.create({
        data: {
          name: "testUser",
          description: "test description",
          deviceIdentityId: createdUser.identity.id,
        },
      });

      const response = await fetch(
        "http://localhost:3004/profiles/check/testuser",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ taken: true });

      // Clean up
      await prisma.profile.delete({ where: { id: profile.id } });
    });

    test("returns 404  for empty username", async () => {
      const response = await fetch("http://localhost:3004/profiles/check/");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Profile not found" });
    });
  });

  test("PUT /profiles/:id allows partial updates", async () => {
    // Create a user first with a complete profile
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privyUserId: "test-profiles-privy-user-id",
        device: {
          os: DeviceOS.ios,
          name: "iPhone 14",
        },
        identity: {
          privyAddress: "test-privy-address",
          xmtpId: "test-xmtp-id",
        },
        profile: {
          name: "Test Profile",
          description: "Test Description",
          avatar: "https://example.com/avatar.jpg",
        },
      }),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    // Update only the name
    const response = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.xmtpId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Updated Name Only",
        }),
      },
    );

    const updatedProfile = (await response.json()) as Profile;

    expect(response.status).toBe(200);
    expect(updatedProfile.name).toBe("Updated Name Only");
    expect(updatedProfile.description).toBe("Test Description"); // Should remain unchanged
    expect(updatedProfile.avatar).toBe("https://example.com/avatar.jpg"); // Should remain unchanged
  });
});
