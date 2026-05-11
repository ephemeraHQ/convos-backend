/**
 * POST /api/v2/agent-templates/create-job — twitter source endpoint tests
 *
 * Covers:
 *   VAL-TB-POST-001: POST source=twitter returns 202 when moderation passes
 *   VAL-TB-POST-002: POST source=twitter returns 422 reason=blocked when moderation blocks
 *   VAL-TB-POST-003: POST source=twitter returns 422 reason=not_agent_request when non-agent
 *   VAL-TB-POST-004: POST source=twitter requires idea in metadata
 *   VAL-TB-POST-005: POST source=twitter validates twitterHandle format
 *   VAL-TB-POST-006: POST source=twitter validates tweetId as numeric
 *   VAL-TB-POST-007: POST source=twitter does NOT require joinUrl
 *   VAL-TB-POST-008: POST source=twitter stores metadata JSON
 *   VAL-TB-POST-009: POST source=twitter requires auth
 *   VAL-TB-POST-010: POST source=twitter returns 403 in production
 *   VAL-TB-POST-011: POST source=twitter limits idea to 4000 chars
 *   VAL-TB-POST-012: POST source=twitter returns 400 for empty idea after stripping mentions
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
import { __resetTwitterModerationForTests } from "@/api/v2/agent-templates/services/twitterModeration";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4080;
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
    deviceId: "test-device-twitter-build-post",
    accountId,
  }),
});

const agentKeyHeaders = (key = validAgentAssetsApiKey) => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": key,
});

const postTwitterJob = async (
  metadata: { idea: string; twitterHandle: string; tweetId: string },
  headers: Record<string, string>,
  extraBody?: Record<string, unknown>,
) =>
  fetch(`${baseURL}/api/v2/agent-templates/create-job`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "twitter",
      metadata,
      ...extraBody,
    }),
  });

const cleanupJobs = async () => {
  await prisma.createJob.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID },
  });
};

// Valid twitter metadata for most tests
const validMetadata = {
  idea: "Build me a math tutor bot",
  twitterHandle: "@alice",
  tweetId: "1234567890",
};

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

describe("POST /api/v2/agent-templates/create-job — twitter source", () => {
  beforeAll(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
    // Mock executor to prevent actual job execution
    __resetJobExecutorForTests({
      executeJob: async () => {
        // no-op stub
      },
    });
    // Mock moderation to allow by default
    __resetTwitterModerationForTests(() => Promise.resolve({ allowed: true }));
    await new Promise<void>((resolve) => {
      server = app.listen(TEST_PORT, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    __resetJobExecutorForTests(null);
    __resetTwitterModerationForTests(null);
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
    // Reset moderation to allow by default
    __resetTwitterModerationForTests(() => Promise.resolve({ allowed: true }));
    await cleanupJobs();
  });

  // ── VAL-TB-POST-001: POST source=twitter returns 202 when moderation passes ──

  test("returns 202 with jobId when moderation passes", async () => {
    const response = await postTwitterJob(validMetadata, await jwtHeaders());

    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string };
    expect(body.jobId).toBeDefined();
    expect(body.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  // ── VAL-TB-POST-002: POST source=twitter returns 422 reason=blocked when moderation blocks ──

  test("returns 422 with reason=blocked when moderation blocks content", async () => {
    __resetTwitterModerationForTests(() =>
      Promise.resolve({ allowed: false, reason: "blocked" }),
    );

    const response = await postTwitterJob(
      { ...validMetadata, idea: "unsafe content here" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as { reason: string };
    expect(body.reason).toBe("blocked");
  });

  // ── VAL-TB-POST-003: POST source=twitter returns 422 reason=not_agent_request when non-agent ──

  test("returns 422 with reason=not_agent_request for non-agent mentions", async () => {
    __resetTwitterModerationForTests(() =>
      Promise.resolve({ allowed: false, reason: "not_agent_request" }),
    );

    const response = await postTwitterJob(
      { ...validMetadata, idea: "follow me back" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as { reason: string };
    expect(body.reason).toBe("not_agent_request");
  });

  // ── VAL-TB-POST-004: POST source=twitter requires idea in metadata ──

  test("returns 400 when idea is missing from metadata", async () => {
    const response = await postTwitterJob(
      { twitterHandle: "@alice", tweetId: "123" } as never,
      await jwtHeaders(),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/idea/i);
  });

  test("returns 400 when idea is empty string", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, idea: "" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/idea/i);
  });

  test("returns 400 when idea is whitespace-only", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, idea: "   " },
      await jwtHeaders(),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/idea/i);
  });

  // ── VAL-TB-POST-005: POST source=twitter validates twitterHandle format ──

  test("returns 400 for invalid twitterHandle with special characters", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, twitterHandle: "invalid!char" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/twitterHandle/i);
  });

  test("returns 400 for twitterHandle exceeding 15 characters", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, twitterHandle: "a".repeat(16) },
      await jwtHeaders(),
    );

    expect(response.status).toBe(400);
  });

  test("returns 400 for missing twitterHandle", async () => {
    const response = await postTwitterJob(
      { idea: "Build a bot", tweetId: "123" } as never,
      await jwtHeaders(),
    );

    expect(response.status).toBe(400);
  });

  test("accepts valid twitterHandle with @ prefix", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, twitterHandle: "@alice" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(202);
  });

  test("accepts valid twitterHandle without @ prefix", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, twitterHandle: "alice" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(202);
  });

  test("accepts valid twitterHandle with underscores", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, twitterHandle: "A_1" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(202);
  });

  // ── VAL-TB-POST-006: POST source=twitter validates tweetId as numeric ──

  test("returns 400 for non-numeric tweetId", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, tweetId: "abc" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/tweetId/i);
  });

  test("returns 400 for decimal tweetId", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, tweetId: "12.3" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(400);
  });

  test("returns 400 for empty tweetId", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, tweetId: "" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(400);
  });

  test("accepts valid numeric tweetId", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, tweetId: "1234567890" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(202);
  });

  // ── VAL-TB-POST-007: POST source=twitter does NOT require joinUrl ──

  test("returns 202 without joinUrl for twitter source", async () => {
    const response = await postTwitterJob(validMetadata, await jwtHeaders());

    expect(response.status).toBe(202);

    // Verify joinUrl is null in DB
    const body = (await response.json()) as { jobId: string };
    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });
    expect(job!.joinUrl).toBeNull();
  });

  test("returns 202 with joinUrl for twitter source (optional)", async () => {
    const response = await postTwitterJob(validMetadata, await jwtHeaders(), {
      joinUrl: "https://example.com/optional",
    });

    expect(response.status).toBe(202);

    // Verify joinUrl is stored
    const body = (await response.json()) as { jobId: string };
    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });
    expect(job!.joinUrl).toBe("https://example.com/optional");
  });

  // ── VAL-TB-POST-008: POST source=twitter stores metadata as JSON ──

  test("stores metadata as JSON with idea, twitterHandle, tweetId", async () => {
    const response = await postTwitterJob(validMetadata, await jwtHeaders());
    const body = (await response.json()) as { jobId: string };

    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });

    expect(job!.metadata).not.toBeNull();
    // metadata is now Prisma Json — already parsed into an object on read.
    const parsed = job!.metadata as {
      idea: string;
      twitterHandle: string;
      tweetId: string;
    };
    expect(parsed.idea).toBe(validMetadata.idea);
    expect(parsed.twitterHandle).toBe(validMetadata.twitterHandle);
    expect(parsed.tweetId).toBe(validMetadata.tweetId);
  });

  // ── VAL-TB-POST-009: POST source=twitter requires auth ──

  test("returns 401 without auth", async () => {
    const response = await postTwitterJob(validMetadata, {
      "Content-Type": "application/json",
    });

    expect(response.status).toBe(401);
  });

  test("accepts X-Agent-API-Key auth", async () => {
    const response = await postTwitterJob(validMetadata, agentKeyHeaders());

    expect(response.status).toBe(202);
  });

  // ── VAL-TB-POST-010: POST source=twitter returns 403 in production ──
  // (tested via production guard in the route setup — covered by existing
  // create-job.guard.test.ts pattern. The production guard applies uniformly
  // to all sources since it's in v2/index.ts router mounting.)

  // ── VAL-TB-POST-011: POST source=twitter limits idea to 4000 chars ──

  test("returns 400 for idea exceeding 4000 characters", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, idea: "a".repeat(4001) },
      await jwtHeaders(),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/4,000|4000/i);
  });

  test("accepts idea at exactly 4000 characters", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, idea: "a".repeat(4000) },
      await jwtHeaders(),
    );

    expect(response.status).toBe(202);
  });

  // ── VAL-TB-POST-012: POST source=twitter returns 400 for empty idea after stripping mentions ──

  test("returns 400 for idea that becomes empty after stripping mentions", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, idea: "@bot @bot2" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/idea/i);
  });

  test("returns 400 for idea that is only mentions and whitespace", async () => {
    const response = await postTwitterJob(
      { ...validMetadata, idea: "@bot  @other" },
      await jwtHeaders(),
    );

    expect(response.status).toBe(400);
  });

  // ── Additional validation: job created with correct source ──

  test("creates job with source=twitter in the database", async () => {
    const response = await postTwitterJob(validMetadata, await jwtHeaders());
    const body = (await response.json()) as { jobId: string };

    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });

    expect(job!.source).toBe("twitter");
    expect(job!.status).toBe("pending");
    expect(job!.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
    expect(job!.expiresAt).toBeNull();
    expect(job!.result).toBeNull();
    expect(job!.error).toBeNull();
  });

  test("creates job with null provisioningInstanceId for twitter source", async () => {
    const response = await postTwitterJob(validMetadata, await jwtHeaders());
    const body = (await response.json()) as { jobId: string };

    const job = await prisma.createJob.findUnique({
      where: { id: body.jobId },
    });

    expect(job!.provisioningInstanceId).toBeNull();
    expect(job!.conversationId).toBeNull();
    expect(job!.inboxId).toBeNull();
  });
});
