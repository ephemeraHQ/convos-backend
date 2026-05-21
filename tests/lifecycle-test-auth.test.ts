import type { Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import express from "express";
import { jsonMiddleware } from "@/middleware/json";
import { lifecycleTestAuthMiddleware } from "@/middleware/lifecycleTestAuth";
import { pinoMiddleware } from "@/middleware/pino";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);

// Test endpoint protected by lifecycleTestAuthMiddleware
app.get("/test", lifecycleTestAuthMiddleware, (_req, res) => {
  res.json({ success: true });
});

describe("lifecycleTestAuthMiddleware", () => {
  let server: Server;
  const baseURL = "http://localhost:4003";
  const originalEnv = process.env.LIFECYCLE_TEST_TOKEN;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4003, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.LIFECYCLE_TEST_TOKEN = originalEnv;
    } else {
      delete process.env.LIFECYCLE_TEST_TOKEN;
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    // Set a valid token for tests (32+ chars)
    process.env.LIFECYCLE_TEST_TOKEN =
      "test-secret-token-for-lifecycle-testing-minimum-32-chars";
  });

  const get = (headers?: Record<string, string>) =>
    fetch(`${baseURL}/test`, {
      method: "GET",
      headers: {
        ...headers,
      },
    });

  // --- Missing token ---

  test("should reject requests without Authorization header", async () => {
    const res = await get();

    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Missing authentication token");
  });

  test("should reject requests with empty Authorization header", async () => {
    const res = await get({ Authorization: "" });

    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Missing authentication token");
  });

  test("should reject requests with empty Bearer token", async () => {
    const res = await get({ Authorization: "Bearer " });

    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Invalid authentication token");
  });

  // --- Invalid token ---

  test("should reject requests with invalid token", async () => {
    const res = await get({ Authorization: "Bearer wrong-token" });

    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Invalid authentication token");
  });

  test("should reject requests with wrong length token", async () => {
    const res = await get({ Authorization: "Bearer short" });

    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Invalid authentication token");
  });

  // --- Server configuration error ---

  test("should return 500 when LIFECYCLE_TEST_TOKEN not configured", async () => {
    delete process.env.LIFECYCLE_TEST_TOKEN;

    const res = await get({
      Authorization: "Bearer some-token",
    });

    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Server configuration error");
  });

  test("should return 500 when LIFECYCLE_TEST_TOKEN is too short", async () => {
    process.env.LIFECYCLE_TEST_TOKEN = "short-token"; // Less than 32 chars

    const res = await get({
      Authorization: "Bearer short-token",
    });

    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Server configuration error");
  });

  // --- Valid token ---

  test("should accept requests with valid Bearer token", async () => {
    const res = await get({
      Authorization:
        "Bearer test-secret-token-for-lifecycle-testing-minimum-32-chars",
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(true);
  });

  test("should accept requests with valid token without Bearer prefix", async () => {
    const res = await get({
      Authorization: "test-secret-token-for-lifecycle-testing-minimum-32-chars",
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(true);
  });

  test("should handle token with whitespace trimming", async () => {
    process.env.LIFECYCLE_TEST_TOKEN =
      "  test-secret-token-for-lifecycle-testing-minimum-32-chars  ";

    const res = await get({
      Authorization:
        "Bearer test-secret-token-for-lifecycle-testing-minimum-32-chars",
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(true);
  });
});
