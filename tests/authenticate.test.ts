import type { Server } from "http";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import * as jose from "jose";
import { rimrafSync } from "rimraf";
import { toHex } from "viem";
import authenticateRouter, {
  type AuthenticateResponse,
} from "@/api/v1/authenticate";
import { jsonMiddleware } from "@/middleware/json";
import { createClient, createHeaders } from "./helpers";

// mock environment variable
process.env.JWT_SECRET = "test-jwt-secret";
process.env.FIREBASE_SERVICE_ACCOUNT = `{"projectId": "test-project-id","privateKey": "test-private-key","clientEmail": "test-client-email"}`;

const app = express();
app.use(jsonMiddleware);
app.use("/authenticate", authenticateRouter);

const prisma = new PrismaClient();
let server: Server;

beforeAll(() => {
  server = app.listen(3009);
});

afterAll(async () => {
  await prisma.$disconnect();
  server.close();
  // clean up the test databases
  rimrafSync("tests/**/*.db3*", { glob: true });
});

describe("/authenticate API", () => {
  test("POST /authenticate succeeds with valid headers", async () => {
    const client = await createClient();
    const headers = createHeaders(client, "valid-app-check-token");
    const response = await fetch("http://localhost:3009/authenticate", {
      method: "POST",
      headers,
    });

    const data = (await response.json()) as AuthenticateResponse;

    expect(response.status).toBe(200);
    expect(data.token).toBeDefined();

    const decoded = await jose.jwtVerify(
      data.token,
      new TextEncoder().encode(process.env.JWT_SECRET),
    );
    expect(decoded.payload.inboxId).toBe(client.inboxId);
  });

  test("POST /authenticate fails with missing or partial headers", async () => {
    const response = await fetch("http://localhost:3009/authenticate", {
      method: "POST",
      headers: {},
    });
    const data = (await response.json()) as { error: string };
    expect(response.status).toBe(500);
    expect(data.error).toBe("Failed to create authentication token");

    const response2 = await fetch("http://localhost:3009/authenticate", {
      method: "POST",
      headers: {
        "X-Firebase-AppCheck": "valid-app-check-token",
      },
    });
    const data2 = (await response2.json()) as { error: string };
    expect(response2.status).toBe(500);
    expect(data2.error).toBe("Failed to create authentication token");

    const response3 = await fetch("http://localhost:3009/authenticate", {
      method: "POST",
      headers: {
        "X-Firebase-AppCheck": "valid-app-check-token",
        "X-XMTP-Signature": "valid-signature",
      },
    });
    const data3 = (await response3.json()) as { error: string };
    expect(response3.status).toBe(500);
    expect(data3.error).toBe("Failed to create authentication token");
  });

  test("POST /authenticate fails with invalid signature", async () => {
    const client = await createClient();
    const headers = createHeaders(client, "valid-app-check-token");
    const response = await fetch("http://localhost:3009/authenticate", {
      method: "POST",
      headers: {
        ...headers,
        "X-XMTP-Signature": toHex(
          client.signWithInstallationKey("invalid-signature"),
        ),
      },
    });

    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(500);
    expect(data.error).toBe("Failed to create authentication token");
  });

  test.skip("POST /authenticate fails with invalid AppCheck token", async () => {
    const client = await createClient();
    const headers = createHeaders(client, "invalid-app-check-token");
    const response = await fetch("http://localhost:3009/authenticate", {
      method: "POST",
      headers,
    });

    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(500);
    expect(data.error).toBe("Failed to create authentication token");
  });
});
