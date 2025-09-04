import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import express from "express";
import { rimrafSync } from "rimraf";
import { AUTH_HEADER, authMiddleware } from "@/middleware/auth";
import { createJwtToken } from "@/utils/jwt";
import { createClient, createJWT } from "./helpers";

const app = express();

// Regular endpoints with just auth middleware
app.get("/restricted-endpoint", authMiddleware, (req, res) => {
  res.status(200).send("OK");
});

// Endpoint that is restricted but allows notification extension access
app.post(
  "/restricted-endpoint-notification-allowed",
  authMiddleware,
  (req, res) => {
    res.status(200).json({ message: "Notification extension accessible" });
  },
);

// Same path, different method (should be denied)
app.get(
  "/restricted-endpoint-notification-allowed",
  authMiddleware,
  (req, res) => {
    res.status(200).json({ message: "Notification extension accessible" });
  },
);

let server: Server;

beforeAll(() => {
  // Mock the helper function to only allow specific test endpoints for notification extension tokens
  void mock.module("@/middleware/auth", () => {
    return {
      isNotificationExtensionAllowedRoute: (method: string, path: string) => {
        // Only allow POST /restricted-endpoint-notification-allowed for notification extension tokens in tests
        return (
          method === "POST" &&
          path === "/restricted-endpoint-notification-allowed"
        );
      },
    };
  });

  server = app.listen(3007);
});

afterAll(() => {
  // Restore mocks
  mock.restore();
  server.close();
  // clean up the test databases
  rimrafSync("tests/**/*.db3*", { glob: true });
});

describe("authMiddleware", () => {
  test("allows request with a valid auth token", async () => {
    const client = await createClient();
    const response = await fetch("http://localhost:3007/restricted-endpoint", {
      headers: {
        [AUTH_HEADER]: await createJWT(client, process.env.JWT_SECRET!),
      },
    });

    expect(response.status).toBe(200);
  });

  test("responds 401 when request is missing auth header", async () => {
    const response = await fetch("http://localhost:3007/restricted-endpoint");

    expect(response.status).toBe(401);
  });

  test("responds 401 when request has invalid auth token", async () => {
    const client = await createClient();
    const response = await fetch("http://localhost:3007/restricted-endpoint", {
      headers: {
        [AUTH_HEADER]: await createJWT(client, "invalid-secret"),
      },
    });

    expect(response.status).toBe(401);
  });

  test("allows access to all endpoints for normal tokens", async () => {
    const client = await createClient();
    const token = await createJwtToken({
      inboxId: client.inboxId,
      xmtpInstallationId: client.installationId,
    });

    // Should allow access to any endpoint
    const testResponse = await fetch(
      "http://localhost:3007/restricted-endpoint",
      {
        headers: { [AUTH_HEADER]: token },
      },
    );
    expect(testResponse.status).toBe(200);

    // Should allow access to allowed routes
    const allowedResponse = await fetch(
      "http://localhost:3007/restricted-endpoint-notification-allowed",
      {
        method: "POST",
        headers: { [AUTH_HEADER]: token },
      },
    );
    expect(allowedResponse.status).toBe(200);

    const allowedBody = (await allowedResponse.json()) as { message: string };
    expect(allowedBody.message).toBe("Notification extension accessible");
  });

  test("restricts access for notification extension only tokens", async () => {
    const client = await createClient();
    const notificationExtensionToken = await createJwtToken({
      inboxId: client.inboxId,
      xmtpInstallationId: client.installationId,
      metadata: {
        notificationExtensionOnly: true,
      },
    });

    // Should deny access to regular endpoints for notification extension only tokens
    const testResponse = await fetch(
      "http://localhost:3007/restricted-endpoint",
      {
        headers: { [AUTH_HEADER]: notificationExtensionToken },
      },
    );
    expect(testResponse.status).toBe(403);

    const testBody = (await testResponse.json()) as { error: string };
    expect(testBody.error).toBe(
      "Notification extension only tokens cannot access this endpoint",
    );

    // Should allow access to allowed routes
    const allowedResponse = await fetch(
      "http://localhost:3007/restricted-endpoint-notification-allowed",
      {
        method: "POST",
        headers: { [AUTH_HEADER]: notificationExtensionToken },
      },
    );
    expect(allowedResponse.status).toBe(200);

    const allowedBody = (await allowedResponse.json()) as { message: string };
    expect(allowedBody.message).toBe("Notification extension accessible");

    // Should deny access to the same endpoint with different method
    const deniedResponse = await fetch(
      "http://localhost:3007/restricted-endpoint-notification-allowed",
      {
        method: "GET", // Different method should be denied
        headers: { [AUTH_HEADER]: notificationExtensionToken },
      },
    );
    expect(deniedResponse.status).toBe(403);
  });
});
