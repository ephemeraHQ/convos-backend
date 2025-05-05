import type { Server } from "http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import express from "express";
import {
  DEFAULT_API_KEY_NAME,
  DEFAULT_USER_NAME,
} from "@/api/v1/wallets/constants";
import type {
  CreateSubOrgRequestBody,
  CreateSubOrgReturned,
} from "@/api/v1/wallets/handlers/create-suborg";
import walletsRouter from "@/api/v1/wallets/wallets.router";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";
import { getServerPort } from "./helpers";

const app = express();
app.use(jsonMiddleware);
app.use(pinoMiddleware);
app.use("/wallets", walletsRouter);

let server: Server;
let port: number;

beforeAll(() => {
  // start the server on a test port
  server = app.listen();
  port = getServerPort(server);
});

afterAll(async () => {
  // disconnect from the database
  await prisma.$disconnect();
  // close the server
  server.close();
});

beforeEach(async () => {
  await prisma.subOrg.deleteMany();
  mock.restore();
});

describe("/wallets API", () => {
  test("POST /wallets creates a new wallet", async () => {
    const subOrgId = "foo";
    const walletAddress = "0x1234";
    const mockCreateSubOrg = mock(() =>
      Promise.resolve({
        subOrganizationId: subOrgId,
        wallet: {
          addresses: [walletAddress],
        },
      }),
    );

    await mock.module("@turnkey/sdk-server", () => ({
      Turnkey: class {
        apiClient() {
          return {
            createSubOrganization: mockCreateSubOrg,
          };
        }
      },
    }));
    const createSubOrgBody: CreateSubOrgRequestBody = {
      challenge: "test-challenge",
      attestation: {
        credentialId: "test-credential-id",
        clientDataJson: "test-client-data-json",
        attestationObject: "test-attestation-object",
        transports: [],
      },
      ephemeralPublicKey: "test-api-key",
    };

    const response = await fetch(`http://localhost:${port}/wallets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createSubOrgBody),
    });

    expect(response.status).toBe(201);

    const data = (await response.json()) as CreateSubOrgReturned;

    expect(data.subOrgId).toEqual(subOrgId);
    expect(data.walletAddress).toEqual(walletAddress);
    expect(mockCreateSubOrg).toHaveBeenCalledTimes(1);
    // Verify that the createSubOrganization was called with the correct parameters
    expect(mockCreateSubOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        rootUsers: [
          expect.objectContaining({
            userName: DEFAULT_USER_NAME,
            apiKeys: [
              expect.objectContaining({
                apiKeyName: DEFAULT_API_KEY_NAME,
                publicKey: createSubOrgBody.ephemeralPublicKey,
                curveType: "API_KEY_CURVE_P256",
              }),
            ],
            authenticators: [
              {
                authenticatorName: "Passkey",
                challenge: createSubOrgBody.challenge,
                attestation: createSubOrgBody.attestation,
              },
            ],
          }),
        ],
      }),
    );

    // Try again with the same credentialId
    const response2 = await fetch(`http://localhost:${port}/wallets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createSubOrgBody),
    });
    expect(response2.status).toBe(200);

    const data2 = (await response2.json()) as CreateSubOrgReturned;
    expect(data2).toEqual(data);
    expect(mockCreateSubOrg).toHaveBeenCalledTimes(1);
  });
});
