import type { Server } from "http";
import { type DeviceIdentity, type IdentitiesOnDevice } from "@prisma/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import identitiesRouter from "@/api/v1/identities/identities.router";
import { jsonMiddleware } from "@/middleware/json";
import { prisma } from "@/utils/prisma";

const app = express();
app.use(jsonMiddleware);

const AUTH_USER_XMTP_ID = "test-xmtp-id";

// Add middleware to simulate authentication for tests
app.use((req, res, next) => {
  // Set xmtpId for testing - this simulates the auth middleware
  req.app.locals.xmtpId = AUTH_USER_XMTP_ID;
  next();
});

app.use("/identities", identitiesRouter);

let server: Server;

beforeAll(() => {
  server = app.listen(3003);
});

afterAll(async () => {
  await prisma.$disconnect();
  server.close();
});

beforeEach(async () => {
  await prisma.profile.deleteMany();
  await prisma.identitiesOnDevice.deleteMany();
  await prisma.conversationMetadata.deleteMany();
  await prisma.deviceIdentity.deleteMany();
  await prisma.device.deleteMany();
  await prisma.user.deleteMany();
});

describe("/identities API", () => {
  const testDeviceId = "test-device-id";
  const testUserId = "test-user-id";

  test("POST /identities/device/:deviceId creates identity and links to device", async () => {
    const device = await prisma.device.create({
      data: {
        id: testDeviceId,
        name: "Test Device",
        os: "ios",
        user: {
          create: {
            id: "test-user-id",
            turnkeyUserId: "test-identities-turnkey-user-id",
          },
        },
      },
    });

    const response = await fetch(
      `http://localhost:3003/identities/device/${device.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnkeyAddress: "0x123",
          xmtpId: AUTH_USER_XMTP_ID,
        }),
      },
    );
    const identity = (await response.json()) as DeviceIdentity;

    expect(response.status).toBe(201);
    expect(identity.turnkeyAddress).toBe("0x123");
    expect(identity.xmtpId).toBe(AUTH_USER_XMTP_ID);

    const response2 = await fetch(
      `http://localhost:3003/identities/device/invalid-device-id`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnkeyAddress: "0x123",
          xmtpId: AUTH_USER_XMTP_ID,
        }),
      },
    );

    expect(response2.status).toBe(404);
    const data = (await response2.json()) as { error: string };
    expect(data.error).toBe("Device not found");
  });

  test("GET /identities/device/:deviceId returns device identities", async () => {
    // create a device and a user
    await prisma.device.create({
      data: {
        id: testDeviceId,
        name: "Test Device",
        os: "ios",
        user: {
          create: {
            id: testUserId,
            turnkeyUserId: "test-identities-turnkey-user-id",
          },
        },
      },
    });

    // create a device identity
    const createResponse = await fetch(
      `http://localhost:3003/identities/device/${testDeviceId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnkeyAddress: "0x123",
          xmtpId: AUTH_USER_XMTP_ID,
        }),
      },
    );
    const createdIdentity = (await createResponse.json()) as DeviceIdentity;

    const response = await fetch(
      `http://localhost:3003/identities/device/${testDeviceId}`,
    );
    const identities = (await response.json()) as DeviceIdentity[];

    expect(response.status).toBe(200);
    expect(identities).toHaveLength(1);
    expect(identities[0].id).toBe(createdIdentity.id);
    expect(identities[0].turnkeyAddress).toBe("0x123");
  });

  test("GET /identities/:identityId returns single identity", async () => {
    // create a device and a user
    await prisma.device.create({
      data: {
        id: testDeviceId,
        name: "Test Device",
        os: "ios",
        user: {
          create: {
            id: testUserId,
            turnkeyUserId: "test-identities-turnkey-user-id",
          },
        },
      },
    });

    // create a device identity
    const createResponse = await fetch(
      `http://localhost:3003/identities/device/${testDeviceId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnkeyAddress: "0x123",
          xmtpId: AUTH_USER_XMTP_ID,
        }),
      },
    );
    const createdIdentity = (await createResponse.json()) as DeviceIdentity;

    const response = await fetch(
      `http://localhost:3003/identities/${createdIdentity.id}`,
    );
    const identity = (await response.json()) as DeviceIdentity;

    expect(response.status).toBe(200);
    expect(identity.id).toBe(createdIdentity.id);
    expect(identity.turnkeyAddress).toBe("0x123");
    expect(identity.xmtpId).toBe(AUTH_USER_XMTP_ID);
  });

  test("PUT /identities/:identityId updates identity", async () => {
    // create a device and a user
    await prisma.device.create({
      data: {
        id: testDeviceId,
        name: "Test Device",
        os: "ios",
        user: {
          create: {
            id: testUserId,
            turnkeyUserId: "test-identities-turnkey-user-id",
          },
        },
      },
    });

    // create a device identity
    const createResponse = await fetch(
      `http://localhost:3003/identities/device/${testDeviceId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnkeyAddress: "0x123",
          xmtpId: AUTH_USER_XMTP_ID,
        }),
      },
    );
    const createdIdentity = (await createResponse.json()) as DeviceIdentity;

    const response = await fetch(
      `http://localhost:3003/identities/${createdIdentity.id}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnkeyAddress: "0x456",
          xmtpId: "new-xmtp-id",
        }),
      },
    );
    const updatedIdentity = (await response.json()) as DeviceIdentity;

    expect(response.status).toBe(200);
    expect(updatedIdentity.id).toBe(createdIdentity.id);
    expect(updatedIdentity.turnkeyAddress).toBe("0x456");
    expect(updatedIdentity.xmtpId).toBe("new-xmtp-id");
  });

  test("POST /identities/:identityId/link links identity to device", async () => {
    // create a device and a user
    await prisma.device.create({
      data: {
        id: testDeviceId,
        name: "Test Device",
        os: "ios",
        user: {
          create: {
            id: testUserId,
            turnkeyUserId: "test-identities-turnkey-user-id",
          },
        },
      },
    });

    // create a device identity
    const createResponse = await fetch(
      `http://localhost:3003/identities/device/${testDeviceId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnkeyAddress: "0x123",
          xmtpId: AUTH_USER_XMTP_ID,
        }),
      },
    );
    const createdIdentity = (await createResponse.json()) as DeviceIdentity;

    // unlink the identity
    const unlinkResponse = await fetch(
      `http://localhost:3003/identities/${createdIdentity.id}/link`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deviceId: testDeviceId,
        }),
      },
    );

    expect(unlinkResponse.status).toBe(204);

    // link the identity
    const response = await fetch(
      `http://localhost:3003/identities/${createdIdentity.id}/link`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deviceId: testDeviceId,
        }),
      },
    );
    const linkResult = (await response.json()) as IdentitiesOnDevice;

    expect(response.status).toBe(201);
    expect(linkResult.deviceId).toBe(testDeviceId);
    expect(linkResult.identityId).toBe(createdIdentity.id);

    // verify the identity is now linked by fetching device identities
    const getResponse = await fetch(
      `http://localhost:3003/identities/device/${testDeviceId}`,
    );
    const deviceIdentities = (await getResponse.json()) as DeviceIdentity[];

    expect(getResponse.status).toBe(200);
    expect(deviceIdentities).toHaveLength(1);
    expect(deviceIdentities[0].id).toBe(createdIdentity.id);
    expect(deviceIdentities[0].turnkeyAddress).toBe("0x123");
  });

  test("DELETE /identities/:identityId/link unlinks identity from device", async () => {
    // create a device and a user
    await prisma.device.create({
      data: {
        id: testDeviceId,
        name: "Test Device",
        os: "ios",
        user: {
          create: {
            id: testUserId,
            turnkeyUserId: "test-identities-turnkey-user-id",
          },
        },
      },
    });

    // create an identity first
    const response = await fetch(
      `http://localhost:3003/identities/device/${testDeviceId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnkeyAddress: "0x123",
          xmtpId: AUTH_USER_XMTP_ID,
        }),
      },
    );
    const identity = (await response.json()) as DeviceIdentity;

    // unlink the identity
    const unlinkResponse = await fetch(
      `http://localhost:3003/identities/${identity.id}/link`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deviceId: testDeviceId,
        }),
      },
    );

    expect(unlinkResponse.status).toBe(204);

    // verify the identity is no longer linked
    const getResponse = await fetch(
      `http://localhost:3003/identities/device/${testDeviceId}`,
    );
    const deviceIdentities = (await getResponse.json()) as DeviceIdentity[];

    expect(getResponse.status).toBe(200);
    expect(deviceIdentities).toHaveLength(0);
  });

  test("POST /identities/device/:deviceId validates request body", async () => {
    const response = await fetch(
      `http://localhost:3003/identities/device/${testDeviceId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // missing required turnkeyAddress
          xmtpId: AUTH_USER_XMTP_ID,
        }),
      },
    );
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe("Invalid request body");
  });

  test("GET /identities/user/:userId returns user identities", async () => {
    // create a device and a user
    await prisma.device.create({
      data: {
        id: testDeviceId,
        name: "Test Device",
        os: "ios",
        user: {
          create: {
            id: testUserId,
            turnkeyUserId: "test-identities-turnkey-user-id",
          },
        },
      },
    });

    // create a device identity
    const createResponse = await fetch(
      `http://localhost:3003/identities/device/${testDeviceId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnkeyAddress: "0x123",
          xmtpId: AUTH_USER_XMTP_ID,
        }),
      },
    );
    const createdIdentity = (await createResponse.json()) as DeviceIdentity;

    const response = await fetch(
      `http://localhost:3003/identities/user/${testUserId}`,
    );
    const identities = (await response.json()) as DeviceIdentity[];

    expect(response.status).toBe(200);
    expect(identities).toHaveLength(1);

    // Verify the identity we just created is in the list
    const foundIdentity = identities.find(
      (identity) => identity.id === createdIdentity.id,
    );
    expect(foundIdentity).toBeDefined();
    expect(foundIdentity?.turnkeyAddress).toBe("0x123");
    expect(foundIdentity?.userId).toBe(testUserId);

    // unlink the identity
    const unlinkResponse = await fetch(
      `http://localhost:3003/identities/${createdIdentity.id}/link`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deviceId: testDeviceId,
        }),
      },
    );

    expect(unlinkResponse.status).toBe(204);

    const response2 = await fetch(
      `http://localhost:3003/identities/user/${testUserId}`,
    );
    const identities2 = (await response2.json()) as DeviceIdentity[];

    expect(response2.status).toBe(200);
    // We expect 1 identity because we unlinked the identity from the device but we still have the identity in the database
    expect(identities2).toHaveLength(1);

    const foundIdentityAfterUnlink = identities2.find(
      (identity) => identity.id === createdIdentity.id,
    );
    expect(foundIdentityAfterUnlink).toBeDefined();
    expect(foundIdentityAfterUnlink?.turnkeyAddress).toBe("0x123");
    expect(foundIdentityAfterUnlink?.userId).toBe(testUserId);
  });

  test("GET /identities/user/:userId returns empty array for non-existent user", async () => {
    const nonExistentUserId = "non-existent-user-id";
    const response = await fetch(
      `http://localhost:3003/identities/user/${nonExistentUserId}`,
    );

    const identities = (await response.json()) as DeviceIdentity[];
    expect(identities).toHaveLength(0);
  });
});
