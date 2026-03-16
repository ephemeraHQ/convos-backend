import type { Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { poolApiKeyAuth } from "@/middleware/poolAuth";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);

app.get("/test", poolApiKeyAuth, (_req, res) => {
  res.json({ success: true });
});

describe("poolApiKeyAuth", () => {
  let server: Server;
  const baseURL = "http://localhost:4010";
  const originalKey = process.env.AGENT_POOL_API_KEY;

  const VALID_KEY = "test-pool-api-key-that-is-at-least-32-characters-long";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4010, () => resolve());
    });
  });

  afterAll(async () => {
    if (originalKey !== undefined) {
      process.env.AGENT_POOL_API_KEY = originalKey;
    } else {
      delete process.env.AGENT_POOL_API_KEY;
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    process.env.AGENT_POOL_API_KEY = VALID_KEY;
  });

  const get = (headers?: Record<string, string>) =>
    fetch(`${baseURL}/test`, { method: "GET", headers });

  // --- Missing / empty auth ---

  test("should reject requests without Authorization header", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Invalid or missing pool API key");
  });

  test("should reject requests with empty Authorization header", async () => {
    const res = await get({ Authorization: "" });
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Invalid or missing pool API key");
  });

  test("should reject requests with Bearer but no token", async () => {
    const res = await get({ Authorization: "Bearer " });
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Invalid or missing pool API key");
  });

  test("should reject requests without Bearer prefix", async () => {
    const res = await get({ Authorization: VALID_KEY });
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Invalid or missing pool API key");
  });

  // --- Invalid token ---

  test("should reject requests with wrong token", async () => {
    const res = await get({ Authorization: "Bearer wrong-token-value-here" });
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Invalid or missing pool API key");
  });

  // --- Server config errors ---

  test("should return 503 when AGENT_POOL_API_KEY is not configured", async () => {
    process.env.AGENT_POOL_API_KEY = "";
    const res = await get({ Authorization: "Bearer some-token" });
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Pool API key not configured");
  });

  test("should return 503 when AGENT_POOL_API_KEY is too short", async () => {
    process.env.AGENT_POOL_API_KEY = "short-key";
    const res = await get({ Authorization: "Bearer short-key" });
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Pool API key not configured");
  });

  // --- Valid token ---

  test("should accept requests with valid Bearer token", async () => {
    const res = await get({ Authorization: `Bearer ${VALID_KEY}` });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(true);
  });

  test("should handle key with whitespace trimming", async () => {
    process.env.AGENT_POOL_API_KEY = `  ${VALID_KEY}  `;
    const res = await get({ Authorization: `Bearer ${VALID_KEY}` });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(true);
  });
});
