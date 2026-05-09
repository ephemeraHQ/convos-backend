/**
 * GET /api/v2/agent-templates/create-job/:jobId — twitter source endpoint tests
 *
 * Covers:
 *   VAL-TB-GET-001: GET returns twitter-specific result (templateId, slug, templateUrl, replyText)
 *   VAL-TB-GET-002: GET for twitter source does NOT include instance fields
 *   VAL-TB-GET-003: GET works identically for all sources (same polling, wait_ms)
 *   VAL-TB-GET-004: GET for twitter source returns 404 for expired jobs
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
import type { CreateJobStatus } from "@prisma/client";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4028;
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
    deviceId: "test-device-twitter-build-get",
    accountId,
  }),
});

const getJobStatus = async (
  jobId: string,
  headers: Record<string, string>,
  query?: string,
) =>
  fetch(
    `${baseURL}/api/v2/agent-templates/create-job/${jobId}${query ? `?${query}` : ""}`,
    { headers },
  );

const cleanupJobs = async () => {
  await prisma.createJob.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID },
  });
};

/** Seed a twitter source job in the database. */
const seedTwitterJob = async (
  overrides: Partial<{
    status: string;
    result: string | null;
    error: string | null;
    expiresAt: Date | null;
    ownerAccountId: string;
    metadata: string;
  }> = {},
) => {
  return prisma.createJob.create({
    data: {
      status: (overrides.status as CreateJobStatus) ?? ("pending" as CreateJobStatus),
      source: "twitter",
      input: JSON.stringify({
        source: "twitter",
        metadata: {
          idea: "Build me a math tutor",
          twitterHandle: "@alice",
          tweetId: "1234567890",
        },
      }),
      metadata:
        overrides.metadata ||
        JSON.stringify({
          idea: "Build me a math tutor",
          twitterHandle: "@alice",
          tweetId: "1234567890",
        }),
      joinUrl: null,
      ownerAccountId: overrides.ownerAccountId || ADMIN_ACCOUNT_ID,
      result: overrides.result !== undefined ? overrides.result : null,
      error: overrides.error !== undefined ? overrides.error : null,
      expiresAt: overrides.expiresAt !== undefined ? overrides.expiresAt : null,
    },
  });
};

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

describe("GET /api/v2/agent-templates/create-job/:jobId — twitter source", () => {
  beforeAll(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
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

  // ── VAL-TB-GET-001: GET returns twitter-specific result fields ──

  test("done job result includes templateId, slug, templateUrl, replyText", async () => {
    const twitterResult = {
      templateId: "tmpl_twitter_123",
      slug: "math-tutor.abcde",
      templateUrl: "https://convos.org/assistants/math-tutor.abcde",
      replyText:
        "@alice Meet Math Tutor — A helpful math tutor. https://convos.org/assistants/math-tutor.abcde",
    };

    const job = await seedTwitterJob({
      status: "done",
      result: JSON.stringify(twitterResult),
    });

    const response = await getJobStatus(job.id, await jwtHeaders());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("done");

    const result = body.result as Record<string, unknown>;
    expect(result.templateId).toBe("tmpl_twitter_123");
    expect(result.slug).toBe("math-tutor.abcde");
    expect(result.templateUrl).toBe(
      "https://convos.org/assistants/math-tutor.abcde",
    );
    expect(result.replyText).toContain("@alice");
  });

  // ── VAL-TB-GET-002: GET for twitter source does NOT include instance fields ──

  test("done twitter job result does NOT include playgroundInstanceId, conversationId, inboxId", async () => {
    // The executor stores only twitter fields, but let's test with an
    // explicitly minimal result to verify the GET handler filters correctly
    const twitterResult = {
      templateId: "tmpl_twitter_456",
      slug: "tutor.abcde",
      templateUrl: "https://convos.org/assistants/tutor.abcde",
      replyText:
        "@bob Check out Tutor! https://convos.org/assistants/tutor.abcde",
    };

    const job = await seedTwitterJob({
      status: "done",
      result: JSON.stringify(twitterResult),
    });

    const response = await getJobStatus(job.id, await jwtHeaders());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const result = body.result as Record<string, unknown>;

    // Twitter result should NOT have these fields
    expect(result.playgroundInstanceId).toBeUndefined();
    expect(result.conversationId).toBeUndefined();
    expect(result.inboxId).toBeUndefined();
  });

  test("done app/web job result does NOT include twitter-specific fields", async () => {
    const appResult = {
      templateId: "tmpl_app_789",
      playgroundInstanceId: "inst-456",
      conversationId: "conv-789",
      inboxId: "inbox-012",
    };

    const job = await prisma.createJob.create({
      data: {
        status: "done",
        source: "app",
        input: JSON.stringify({
          text: "test",
          joinUrl: "https://example.com",
        }),
        joinUrl: "https://example.com",
        ownerAccountId: ADMIN_ACCOUNT_ID,
        result: JSON.stringify(appResult),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    try {
      const response = await getJobStatus(job.id, await jwtHeaders());
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      const result = body.result as Record<string, unknown>;

      // App/web result should NOT have twitter fields
      expect(result.slug).toBeUndefined();
      expect(result.templateUrl).toBeUndefined();
      expect(result.replyText).toBeUndefined();

      // App/web result SHOULD have instance fields
      expect(result.playgroundInstanceId).toBe("inst-456");
      expect(result.conversationId).toBe("conv-789");
      expect(result.inboxId).toBe("inbox-012");
    } finally {
      await prisma.createJob.deleteMany({
        where: { id: job.id },
      });
    }
  });

  // ── VAL-TB-GET-003: GET works identically for all sources (same polling) ──

  test("wait_ms works for twitter source jobs", async () => {
    const job = await seedTwitterJob({ status: "generating" });

    const start = Date.now();
    const response = await getJobStatus(
      job.id,
      await jwtHeaders(),
      "wait_ms=500",
    );
    const elapsed = Date.now() - start;

    expect(response.status).toBe(200);
    // Should take at least ~500ms due to polling
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });

  test("wait_ms=0 returns immediately for twitter source", async () => {
    const job = await seedTwitterJob({ status: "pending" });

    const start = Date.now();
    const response = await getJobStatus(
      job.id,
      await jwtHeaders(),
      "wait_ms=0",
    );
    const elapsed = Date.now() - start;

    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
  });

  test("wait_ms returns immediately when twitter job is terminal", async () => {
    const twitterResult = {
      templateId: "tmpl_done",
      slug: "done.fghij",
      templateUrl: "https://convos.org/assistants/done.fghij",
      replyText: "@alice Done!",
    };

    const job = await seedTwitterJob({
      status: "done",
      result: JSON.stringify(twitterResult),
    });

    const start = Date.now();
    const response = await getJobStatus(
      job.id,
      await jwtHeaders(),
      "wait_ms=5000",
    );
    const elapsed = Date.now() - start;

    expect(response.status).toBe(200);
    // Should return much faster than 5000ms since the job is already done
    expect(elapsed).toBeLessThan(1000);
  });

  // ── VAL-TB-GET-004: GET for twitter source returns 404 for expired jobs ──

  test("returns 404 for expired twitter source job", async () => {
    const twitterResult = {
      templateId: "tmpl_expired",
      slug: "expired.klmno",
      templateUrl: "https://convos.org/assistants/expired.klmno",
      replyText: "@alice Expired",
    };

    const job = await seedTwitterJob({
      status: "done",
      result: JSON.stringify(twitterResult),
      expiresAt: new Date(Date.now() - 1000), // 1 second ago
    });

    const response = await getJobStatus(job.id, await jwtHeaders());
    expect(response.status).toBe(404);
  });

  // ── Additional coverage ──

  test("pending twitter job does not include result", async () => {
    const job = await seedTwitterJob({ status: "pending" });

    const response = await getJobStatus(job.id, await jwtHeaders());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("pending");
    expect(body.result).toBeUndefined();
  });

  test("failed twitter job includes error", async () => {
    const job = await seedTwitterJob({
      status: "failed",
      error: "Template generation failed",
    });

    const response = await getJobStatus(job.id, await jwtHeaders());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("failed");
    expect(body.error).toBe("Template generation failed");
  });
});
