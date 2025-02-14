import type { Server } from "http";
import type { Client } from "@xmtp/node-sdk";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import { rimrafSync } from "rimraf";
import { toHex } from "viem";
import { authMiddleware } from "@/middleware/auth";
import { createClient } from "./helpers";

const TEST_APP_CHECK_TOKEN = "valid-appcheck-token";

const app = express();
app.use(authMiddleware);
app.get("/test", (req, res) => {
  res.status(200).send("OK");
});

let server: Server;

beforeAll(() => {
  server = app.listen(3007);
});

afterAll(() => {
  server.close();
  // clean up the test databases
  rimrafSync("tests/**/*.db3*", { glob: true });
});

describe("authMiddleware", () => {
  let xmtpClient: Client;
  let testHeaders: Record<string, string>;

  beforeEach(async () => {
    // create a new XMTP client for each test
    xmtpClient = await createClient();

    // Get the installation ID from the client
    const installationId = xmtpClient.installationId;
    // sign the appcheck token with the installation key
    const signature = xmtpClient.signWithInstallationKey(TEST_APP_CHECK_TOKEN);

    // create the headers for the request
    testHeaders = {
      "X-Firebase-AppCheck": TEST_APP_CHECK_TOKEN,
      "X-XMTP-InstallationId": installationId,
      "X-XMTP-InboxId": xmtpClient.inboxId,
      "X-XMTP-Signature": toHex(signature),
    };
  });

  test("allows request with valid headers and authentication", async () => {
    const response = await fetch("http://localhost:3007/test", {
      headers: testHeaders,
    });

    expect(response.status).toBe(200);
  }, 60000);

  test("rejects request with missing headers", async () => {
    const response = await fetch("http://localhost:3007/test");

    expect(response.status).toBe(401);
  });

  test("rejects request with invalid installation ID", async () => {
    const response = await fetch("http://localhost:3007/test", {
      headers: {
        ...testHeaders,
        "X-XMTP-InstallationId": toHex(
          new TextEncoder().encode("invalid-id"),
        ).slice(2),
      },
    });

    expect(response.status).toBe(401);
  });

  test("rejects request with invalid signature", async () => {
    // create a different client to generate an invalid signature
    const differentClient = await createClient();

    const invalidSignature = differentClient.signWithInstallationKey(
      "valid-appcheck-token",
    );

    const response = await fetch("http://localhost:3007/test", {
      headers: {
        ...testHeaders,
        "X-XMTP-Signature": toHex(invalidSignature),
      },
    });

    expect(response.status).toBe(401);
  });

  test("rejects request with partial headers", async () => {
    const partialHeaders = {
      "X-Firebase-AppCheck": testHeaders["X-Firebase-AppCheck"],
      "X-XMTP-InstallationId": testHeaders["X-XMTP-InstallationId"],
    };

    const response = await fetch("http://localhost:3007/test", {
      headers: partialHeaders,
    });

    expect(response.status).toBe(401);
  });
});
