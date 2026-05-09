/**
 * POST /api/v2/agent-templates/create-job — endpoint tests
 *
 * Covers:
 *   VAL-CJ-POST-001: POST returns 202 { jobId }
 *   VAL-CJ-POST-002: POST returns 401 without auth
 *   VAL-CJ-POST-003: POST returns 401 with invalid JWT
 *   VAL-CJ-POST-004: POST accepts X-Agent-API-Key auth
 *   VAL-CJ-POST-013: POST creates a pending job
 *   VAL-CJ-POST-016: POST stores input as JSON
 *   VAL-CJ-POST-017: POST sets ownerAccountId from auth
 *   VAL-CJ-POST-022: POST creates job with null expiresAt
 *   VAL-CJ-POST-023: POST creates job with null result and error
 *   VAL-CJ-POST-024: POST response contains only jobId
 *   VAL-CJ-POST-025: POST ignores unknown extra fields
 *   VAL-CJ-POST-020: Multiple POSTs create separate jobs
 *   VAL-CJ-POST-014: POST accepts pdfBase64 input
 *   VAL-CJ-POST-015: POST accepts imageBase64 input
 */

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
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { __resetJobExecutorForTests } from "@/api/v2/agent-templates/services/job-executor";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken } from "@/utils/jwt";
import { ADMIN_ACCOUNT_ID } from "@/utils/prefixed-id";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4025;
const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";
const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/agent-templates", agentTemplatesRouter);
app.use(noRouteMiddleware);

let server: Server;
const baseURL = `http://localhost:${TEST_PORT}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const jwtHeaders = async (accountId: string = ADMIN_ACCOUNT_ID) => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-create-job-post",
    accountId,
  }),
});

const agentKeyHeaders = (key = validAgentAssetsApiKey) => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": key,
});

const postCreateJob = async (
  body: Record<string, unknown>,
  headers: Record<string, string>,
) =>
  fetch(`${baseURL}/api/v2/agent-templates/create-job`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

const cleanupJobs = async () => {
  await prisma.createJob.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID },
  });
};

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

describe("POST /api/v2/agent-templates/create-job", () => {
  beforeAll(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
    // Mock executor to prevent actual job execution
    __resetJobExecutorForTests({
      executeJob: async () => {
        // no-op stub
      },
    });
    await new Promise<void>((resolve) => {
      server = app.listen(TEST_PORT, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    __resetJobExecutorForTests(null);
    if (originalAgentAssetsApiKey === undefined) {
      delete process.env.AGENT_ASSETS_API_KEY;
    } else {
      process.env.AGENT_ASSETS_API_KEY = originalAgentAssetsApiKey;
    }
    await cleanupJobs();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
    await cleanupJobs();
  });

  // ── VAL-CJ-POST-001: POST returns 202 with jobId ──

  test("returns 202 with jobId for valid text input", async () => {
    const response = await postCreateJob(
      {
        text: "A helpful math tutor",
        joinUrl: "xmtp:https://example.com/join",
      },
      await jwtHeaders(),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string };
    expect(body.jobId).toBeDefined();
    expect(body.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  // ── VAL-CJ-POST-002: POST returns 401 without auth ──

  test("returns 401 without auth", async () => {
    const response = await postCreateJob(
      { text: "hello", joinUrl: "https://example.com/join" },
      { "Content-Type": "application/json" },
    );

    expect(response.status).toBe(401);
  });

  // ── VAL-CJ-POST-003: POST returns 401 with invalid JWT ──

  test("returns 401 with invalid JWT", async () => {
    const response = await postCreateJob(
      { text: "hello", joinUrl: "https://example.com/join" },
      {
        "Content-Type": "application/json",
        "X-Convos-AuthToken": "invalid.jwt.token",
      },
    );

    expect(response.status).toBe(401);
  });

  // ── VAL-CJ-POST-004: POST accepts X-Agent-API-Key auth ──

  test("accepts X-Agent-API-Key authentication", async () => {
    const response = await postCreateJob(
      { text: "hello", joinUrl: "https://example.com/join" },
      agentKeyHeaders(),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string };
    expect(body.jobId).toBeDefined();
  });

  // ── VAL-CJ-POST-013: POST creates job with status=pending ──

  test("creates a pending job in the database", async () => {
    const response = await postCreateJob(
      {
        text: "A helpful math tutor",
        joinUrl: "xmtp:https://example.com/join",
      },
      await jwtHeaders(),
    );
    const body = (await response.json()) as { jobId: string };

    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });

    expect(job).not.toBeNull();
    expect(job!.status).toBe("pending");
  });

  // ── VAL-CJ-POST-014: POST accepts pdfBase64 input ──

  test("creates a pending job with pdfBase64 input", async () => {
    const response = await postCreateJob(
      {
        pdfBase64: "dGVzdA==",
        mimeType: "application/pdf",
        joinUrl: "https://example.com/join",
      },
      await jwtHeaders(),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string };

    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });
    expect(job!.status).toBe("pending");
  });

  // ── VAL-CJ-POST-015: POST accepts imageBase64 input ──

  test("creates a pending job with imageBase64 input", async () => {
    const response = await postCreateJob(
      {
        imageBase64: "iVBORw0KGgo=",
        mimeType: "image/png",
        joinUrl: "https://example.com/join",
      },
      await jwtHeaders(),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string };

    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });
    expect(job!.status).toBe("pending");
  });

  // ── VAL-CJ-POST-016: POST stores input as JSON ──

  test("stores input as JSON in the input column", async () => {
    const inputBody = {
      text: "A helpful math tutor",
      joinUrl: "xmtp:https://example.com/join",
    };

    const response = await postCreateJob(inputBody, await jwtHeaders());
    const body = (await response.json()) as { jobId: string };

    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });

    const storedInput = JSON.parse(job!.input) as {
      text: string;
      joinUrl: string;
    };
    expect(storedInput.text).toBe(inputBody.text);
    expect(storedInput.joinUrl).toBe(inputBody.joinUrl);
  });

  // ── VAL-CJ-POST-017: POST sets ownerAccountId from auth ──

  test("sets ownerAccountId from authenticated user (JWT)", async () => {
    const response = await postCreateJob(
      { text: "hello", joinUrl: "https://example.com/join" },
      await jwtHeaders(),
    );
    const body = (await response.json()) as { jobId: string };

    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });

    // JWT without accountId → falls back to ADMIN_ACCOUNT_ID
    expect(job!.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  test("sets ownerAccountId to ADMIN_ACCOUNT_ID for API key auth", async () => {
    const response = await postCreateJob(
      { text: "hello", joinUrl: "https://example.com/join" },
      agentKeyHeaders(),
    );
    const body = (await response.json()) as { jobId: string };

    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });

    expect(job!.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  // ── VAL-CJ-POST-022: POST creates job with null expiresAt ──

  test("creates job with null expiresAt initially", async () => {
    const response = await postCreateJob(
      { text: "hello", joinUrl: "https://example.com/join" },
      await jwtHeaders(),
    );
    const body = (await response.json()) as { jobId: string };

    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });

    expect(job!.expiresAt).toBeNull();
  });

  // ── VAL-CJ-POST-023: POST creates job with null result and error ──

  test("creates job with null result and null error", async () => {
    const response = await postCreateJob(
      { text: "hello", joinUrl: "https://example.com/join" },
      await jwtHeaders(),
    );
    const body = (await response.json()) as { jobId: string };

    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });

    expect(job!.result).toBeNull();
    expect(job!.error).toBeNull();
  });

  // ── VAL-CJ-POST-024: POST response contains only jobId ──

  test("response body contains only jobId and no sensitive data", async () => {
    const response = await postCreateJob(
      { text: "hello", joinUrl: "https://example.com/join" },
      await jwtHeaders(),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body)).toEqual(["jobId"]);
    expect(body.ownerAccountId).toBeUndefined();
    expect(body.input).toBeUndefined();
    expect(body.result).toBeUndefined();
    expect(body.error).toBeUndefined();
  });

  // ── VAL-CJ-POST-025: POST ignores unknown extra fields ──

  test("ignores unknown extra fields in request body", async () => {
    const response = await postCreateJob(
      {
        text: "hello",
        joinUrl: "https://example.com/join",
        extraField: "should be ignored",
        anotherUnknown: 42,
      },
      await jwtHeaders(),
    );

    expect(response.status).toBe(202);
  });

  // ── VAL-CJ-POST-020: Multiple POSTs create separate jobs ──

  test("multiple calls create separate jobs with different IDs", async () => {
    const input = { text: "hello", joinUrl: "https://example.com/join" };

    const response1 = await postCreateJob(input, await jwtHeaders());
    const response2 = await postCreateJob(input, await jwtHeaders());

    expect(response1.status).toBe(202);
    expect(response2.status).toBe(202);

    const body1 = (await response1.json()) as { jobId: string };
    const body2 = (await response2.json()) as { jobId: string };

    expect(body1.jobId).not.toBe(body2.jobId);

    // Both jobs exist in the DB
    const count = await prisma.createJob.count({
      where: {
        id: { in: [body1.jobId, body2.jobId] },
      },
    });
    expect(count).toBe(2);
  });
});
