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
import profilesRouter, { type SearchProfilesResult } from "@/api/v1/profiles";
import usersRouter, { type CreatedUser } from "@/api/v1/users";
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
    const createdUser = (await createUserResponse.json()) as CreatedUser;

    // Create a profile
    const createProfileResponse = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Profile",
          description: "Test Description",
        }),
      },
    );

    const createdProfile = (await createProfileResponse.json()) as Profile;

    const response = await fetch(
      `http://localhost:3004/profiles/${createdProfile.id}`,
    );
    const profile = (await response.json()) as Profile;

    expect(response.status).toBe(200);
    expect(profile.id).toBe(createdProfile.id);
    expect(profile.name).toBe("Test Profile");
    expect(profile.description).toBe("Test Description");
  });

  test("POST /profiles/:deviceIdentityId creates a new profile", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3004/users", {
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
    const createdUser = (await createUserResponse.json()) as CreatedUser;

    // Create a profile
    const createProfileResponse = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Profile",
          description: "Test Description",
        }),
      },
    );

    const createdProfile = (await createProfileResponse.json()) as Profile;

    expect(createProfileResponse.status).toBe(201);
    expect(createdProfile.name).toBe("Test Profile");
    expect(createdProfile.description).toBe("Test Description");
    expect(createdProfile.deviceIdentityId).toBe(createdUser.identity.id);
  });

  test("POST /profiles/:deviceIdentityId returns 404 for non-existent device identity", async () => {
    const response = await fetch(
      "http://localhost:3004/profiles/nonexistent-id",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "New Profile",
          description: "New Description",
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Device identity not found",
    });
  });

  test("POST /profiles/:deviceIdentityId returns 409 if profile already exists", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3004/users", {
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
    const createdUser = (await createUserResponse.json()) as CreatedUser;

    // Create a profile
    await fetch(`http://localhost:3004/profiles/${createdUser.identity.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test Profile",
        description: "Test Description",
      }),
    });

    // Try to create another profile for the same device identity
    const createProfileResponse = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Profile",
          description: "Test Description",
        }),
      },
    );

    expect(createProfileResponse.status).toBe(409);
    expect(await createProfileResponse.json()).toEqual({
      error: "Profile already exists for this device identity",
    });
  });

  test("POST /profiles/:deviceIdentityId returns 400 for invalid request body", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3004/users", {
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
    const createdUser = (await createUserResponse.json()) as CreatedUser;

    const response = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Missing required 'name' field
          description: "New Description",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
  });

  test("PUT /profiles/:id updates profile", async () => {
    // Create a user first
    const createUserResponse = await fetch("http://localhost:3004/users", {
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
    const createdUser = (await createUserResponse.json()) as CreatedUser;

    // Create a profile
    const createProfileResponse = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Profile",
          description: "Test Description",
        }),
      },
    );

    const createdProfile = (await createProfileResponse.json()) as Profile;

    // Update the profile
    const response = await fetch(
      `http://localhost:3004/profiles/${createdProfile.id}`,
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
    expect(updatedProfile.id).toBe(createdProfile.id);
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
    const createdUser = (await createUserResponse.json()) as CreatedUser;

    // Create a profile
    const createProfileResponse = await fetch(
      `http://localhost:3004/profiles/${createdUser.identity.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Profile",
          description: "Test Description",
        }),
      },
    );

    const createdProfile = (await createProfileResponse.json()) as Profile;

    const response = await fetch(
      `http://localhost:3004/profiles/${createdProfile.id}`,
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
    expect(await response.json()).toEqual({ error: "Invalid request body" });
  });

  test("PUT /profiles/:id returns 404 for non-existent profile", async () => {
    const response = await fetch(
      `http://localhost:3004/profiles/nonexistent-id`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Profile",
          description: "Test Description",
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Profile not found" });
  });

  test("GET /profiles/search returns matching profiles", async () => {
    // Create a user with a profile
    const createUserResponse = await fetch("http://localhost:3004/users", {
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
    const createdUser = (await createUserResponse.json()) as CreatedUser;

    // Create a profile
    await fetch(`http://localhost:3004/profiles/${createdUser.identity.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Alice Wonder",
        description: "Test Description",
      }),
    });

    // Search for the profile
    const searchResponse = await fetch(
      "http://localhost:3004/profiles/search?query=Alice",
    );
    const results = (await searchResponse.json()) as SearchProfilesResult[];

    expect(searchResponse.status).toBe(200);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Alice Wonder");
    expect(results[0].description).toBe("Test Description");
    expect(results[0].xmtpId).toBe("test-xmtp-id");
  });

  test("GET /profiles/search is case insensitive", async () => {
    // Create a user with a profile
    const createUserResponse = await fetch("http://localhost:3004/users", {
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
    const createdUser = (await createUserResponse.json()) as CreatedUser;

    // Create a profile
    await fetch(`http://localhost:3004/profiles/${createdUser.identity.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Alice Wonder",
        description: "Test Description",
      }),
    });

    // Search with lowercase
    const searchResponse = await fetch(
      "http://localhost:3004/profiles/search?query=alice",
    );
    const results = (await searchResponse.json()) as SearchProfilesResult[];

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
    const results = (await searchResponse.json()) as SearchProfilesResult[];

    expect(searchResponse.status).toBe(200);
    expect(results).toHaveLength(0);
  });
});
