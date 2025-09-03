import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { rimrafSync } from "rimraf";
import { AUTH_HEADER, authMiddleware } from "@/middleware/auth";
import { createJwtToken } from "@/utils/jwt";
import { createClient, createJWT } from "./helpers";

// mock environment variable

const app = express();
app.use(authMiddleware);
app.get("/test", (req, res) => {
  res.status(200).send("OK");
});
app.get("/profiles", (req, res) => {
  res.status(200).send("Profiles OK");
});
app.get("/admin", (req, res) => {
  res.status(200).send("Admin OK");
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
  test("allows request with a valid auth token", async () => {
    const client = await createClient();
    const response = await fetch("http://localhost:3007/test", {
      headers: {
        [AUTH_HEADER]: await createJWT(client, process.env.JWT_SECRET!),
      },
    });

    expect(response.status).toBe(200);
  });

  test("responds 401 when request is missing auth header", async () => {
    const response = await fetch("http://localhost:3007/test");

    expect(response.status).toBe(401);
  });

  test("responds 401 when request has invalid auth token", async () => {
    const client = await createClient();
    const response = await fetch("http://localhost:3007/test", {
      headers: {
        [AUTH_HEADER]: await createJWT(client, "invalid-secret"),
      },
    });

    expect(response.status).toBe(401);
  });

  test("allows access to all endpoints when no allowedEndpoints specified", async () => {
    const client = await createClient();
    const token = await createJwtToken({
      inboxId: client.inboxId,
      xmtpInstallationId: client.installationId,
    });

    // Should allow access to any endpoint
    const testResponse = await fetch("http://localhost:3007/test", {
      headers: { [AUTH_HEADER]: token },
    });
    expect(testResponse.status).toBe(200);

    const profilesResponse = await fetch("http://localhost:3007/profiles", {
      headers: { [AUTH_HEADER]: token },
    });
    expect(profilesResponse.status).toBe(200);

    const adminResponse = await fetch("http://localhost:3007/admin", {
      headers: { [AUTH_HEADER]: token },
    });
    expect(adminResponse.status).toBe(200);
  });

  test("restricts access based on allowedEndpoints", async () => {
    const client = await createClient();
    const restrictedToken = await createJwtToken({
      inboxId: client.inboxId,
      xmtpInstallationId: client.installationId,
      metadata: {
        allowedEndpoints: ["/test", "/profiles"],
      },
    });

    // Should allow access to allowed endpoints
    const testResponse = await fetch("http://localhost:3007/test", {
      headers: { [AUTH_HEADER]: restrictedToken },
    });
    expect(testResponse.status).toBe(200);

    const profilesResponse = await fetch("http://localhost:3007/profiles", {
      headers: { [AUTH_HEADER]: restrictedToken },
    });
    expect(profilesResponse.status).toBe(200);

    // Should deny access to non-allowed endpoint
    const adminResponse = await fetch("http://localhost:3007/admin", {
      headers: { [AUTH_HEADER]: restrictedToken },
    });
    expect(adminResponse.status).toBe(403);

    const adminBody = (await adminResponse.json()) as { error: string };
    expect(adminBody.error).toBe("Access denied for this endpoint");
  });
});
