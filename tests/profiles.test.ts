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
import type {
  CreatedReturnedUser,
  CreateUserRequestBody,
} from "@/api/v1/users/handlers/create-user";
import usersRouter from "@/api/v1/users/users.router";
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

const createUserBody: CreateUserRequestBody = {
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
    name: "TestProfile123",
    username: "testuser123",
    description: "Test Description",
  },
};

const firstUserBody: CreateUserRequestBody = {
  privyUserId: "test-profiles-privy-user-id-6",
  device: {
    os: DeviceOS.ios,
    name: "iPhone 14 Pro",
  },
  identity: {
    privyAddress: "test-privy-address-6",
    xmtpId: "test-xmtp-id-6",
  },
  profile: {
    name: "ExistingUser123",
    username: "existinguser123",
    description: "First user description",
  },
};

const secondUserBody: CreateUserRequestBody = {
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
    name: "OriginalUser123",
    username: "originaluser123",
    description: "Second user description",
  },
};

describe("/profiles API", () => {
  test("GET /profiles/:id returns 404 for non-existent profile", async () => {
    const response = await fetch(
      "http://localhost:3004/profiles/nonexistent-id",
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Profile not found" });
  });

  test("GET /profiles/:id returns profile when exists", async () => {
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    const response = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.xmtpId}`,
    );
    const profile = (await response.json()) as Profile;

    expect(response.status).toBe(200);
    expect(profile.id).toBe(createdUser.profile.id);
    expect(profile.name).toBe("TestProfile123");
    expect(profile.description).toBe("Test Description");
  });

  test("PUT /profiles/:id updates profile", async () => {
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
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
          name: "UpdatedName123",
          username: "updated-user-123",
          description: "Updated Description",
        }),
      },
    );

    const updatedProfile = (await response.json()) as Profile;

    expect(response.status).toBe(200);
    expect(updatedProfile.id).toBe(createdUser.profile.id);
    expect(updatedProfile.name).toBe("UpdatedName123");
    expect(updatedProfile.username).toBe("updated-user-123");
    expect(updatedProfile.description).toBe("Updated Description");
  });

  test("PUT /profiles/:id returns 400 for invalid characters in name", async () => {
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
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
          name: "Test@Profile", // Contains special characters
        }),
      },
    );

    expect(response.status).toBe(400);
    const result = (await response.json()) as ProfileValidationResponse;
    expect(result.success).toBe(false);
    expect(result.errors?.name).toBe(
      "Name can only contain letters, numbers and spaces",
    );
  });

  test("PUT /profiles/:id returns 400 for invalid characters in username", async () => {
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
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
          username: "test_user!", // Contains underscore and special characters
        }),
      },
    );

    expect(response.status).toBe(400);
    const result = (await response.json()) as ProfileValidationResponse;
    expect(result.success).toBe(false);
    expect(result.errors?.username).toBe(
      "Username can only contain letters, numbers and dashes",
    );
  });

  test("PUT /profiles/:id returns 400 for invalid request body", async () => {
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
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
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
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
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
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
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
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
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
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
    expect(result.errors?.avatar).toBe("Avatar must be a valid URL");
  });

  test("PUT /profiles/:id returns 409 for duplicate username", async () => {
    await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(firstUserBody),
    });

    const createSecondUserResponse = await fetch(
      "http://localhost:3004/users",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(secondUserBody),
      },
    );
    const secondUser =
      (await createSecondUserResponse.json()) as CreatedReturnedUser;

    // Try to update second user's username to first user's username
    const response = await fetch(
      `http://localhost:3004/profiles/${secondUser.identity.xmtpId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: "existinguser123", // Already taken by first user
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
      body: JSON.stringify(createUserBody),
    });

    // Search for the profile
    const searchResponse = await fetch(
      "http://localhost:3004/profiles/search?query=TestProfile123",
    );
    const results = (await searchResponse.json()) as ProfileRequestResult[];

    expect(searchResponse.status).toBe(200);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("TestProfile123");
    expect(results[0].username).toBe("testuser123");
    expect(results[0].description).toBe("Test Description");
  });

  test("GET /profiles/search is case insensitive", async () => {
    // Create a user with a profile
    await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });

    // Search with lowercase
    const searchResponse = await fetch(
      "http://localhost:3004/profiles/search?query=testprofile123",
    );
    const results = (await searchResponse.json()) as ProfileRequestResult[];

    expect(searchResponse.status).toBe(200);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("TestProfile123");
    expect(results[0].username).toBe("testuser123");
    expect(results[0].description).toBe("Test Description");
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
      body: JSON.stringify(createUserBody),
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
    expect(updatedProfile.id).toBe(createdUser.profile.id);
    expect(updatedProfile.name).toBe("TestProfile123"); // unchanged
    expect(updatedProfile.description).toBe("Test Description"); // unchanged
    expect(updatedProfile.avatar).toBe("https://example.com/new-avatar.jpg");
  });

  describe("GET /profiles/check/:username", () => {
    test("returns false for non-existent username", async () => {
      const response = await fetch(
        "http://localhost:3004/profiles/check/nonexistent-user-123",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ taken: false });
    });

    test("returns true for existing username", async () => {
      // Create a user first
      await fetch("http://localhost:3004/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createUserBody),
      });

      const response = await fetch(
        "http://localhost:3004/profiles/check/testuser123",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ taken: true });
    });

    test("is case insensitive", async () => {
      // Create a user first
      await fetch("http://localhost:3004/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createUserBody),
      });

      const response = await fetch(
        "http://localhost:3004/profiles/check/TESTUSER123",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ taken: true });
    });

    test("returns 404  for empty username", async () => {
      const response = await fetch("http://localhost:3004/profiles/check/");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Profile not found" });
    });
  });

  test("PUT /profiles/:id allows partial updates", async () => {
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
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
          name: "UpdatedName123",
        }),
      },
    );

    const updatedProfile = (await response.json()) as Profile;

    expect(response.status).toBe(200);
    expect(updatedProfile.name).toBe("UpdatedName123");
    expect(updatedProfile.username).toBe("testuser123"); // Should remain unchanged
    expect(updatedProfile.description).toBe("Test Description"); // Should remain unchanged
  });

  test("PUT /profiles/:id validates name format", async () => {
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
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
          name: "Test@Profile", // Contains special characters
        }),
      },
    );

    expect(response.status).toBe(400);
    const result = (await response.json()) as ProfileValidationResponse;
    expect(result.success).toBe(false);
    expect(result.errors?.name).toBe(
      "Name can only contain letters, numbers and spaces",
    );
  });

  test("POST /users validates required profile fields", async () => {
    const invalidBody = {
      ...createUserBody,
      profile: {
        // Missing required fields
        description: "Test Description",
      },
    };

    const response = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(invalidBody),
    });

    expect(response.status).toBe(400);
    const result = (await response.json()) as ProfileValidationResponse;
    expect(result.success).toBe(false);
    expect(result.errors?.name).toBeTruthy();
    expect(result.errors?.username).toBeTruthy();
  });

  test("PUT /profiles/:id allows optional fields to be omitted", async () => {
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
    });
    const createdUser =
      (await createUserResponse.json()) as CreatedReturnedUser;

    // Update with minimal data
    const response = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.xmtpId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: "newuser123",
        }),
      },
    );

    expect(response.status).toBe(200);
    const updatedProfile = (await response.json()) as Profile;
    expect(updatedProfile.username).toBe("newuser123");
    expect(updatedProfile.name).toBe("TestProfile123"); // Unchanged
    expect(updatedProfile.description).toBe("Test Description"); // Unchanged
  });

  test("PUT /profiles/:id validates all provided fields", async () => {
    const createUserResponse = await fetch("http://localhost:3004/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createUserBody),
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
          name: "ab", // Too short
          username: "test@123", // Invalid characters
          description: "a".repeat(501), // Too long
          avatar: "not-a-url", // Invalid URL
        }),
      },
    );

    expect(response.status).toBe(400);
    const result = (await response.json()) as ProfileValidationResponse;
    expect(result.success).toBe(false);
    expect(result.errors?.name).toBe("Name must be at least 3 characters long");
    expect(result.errors?.username).toBe(
      "Username can only contain letters, numbers and dashes",
    );
    expect(result.errors?.description).toBe(
      "Description cannot exceed 500 characters",
    );
    expect(result.errors?.avatar).toBe("Avatar must be a valid URL");
  });
});
