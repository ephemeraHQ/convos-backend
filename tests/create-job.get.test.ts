/**
 * GET /api/v2/agent-templates/create-job/:jobId — endpoint tests
 *
 * Covers:
 *   GET returns job status
 *   GET returns 404 for nonexistent jobId
 *   GET returns 401 without auth
 *   GET returns 404 for another account's job
 *   GET response includes result when status is done
 *   GET response includes error when status is failed
 *   GET response omits result when status is not done
 *   GET response omits error when status is not failed
 *   GET supports wait_ms for long-polling
 *   GET caps wait_ms at 45,000ms
 *   GET with wait_ms=0 returns immediately
 *   GET with wait_ms returns immediately when job is terminal
 *   GET with negative wait_ms returns 400
 *   GET with non-numeric wait_ms returns 400
 *   GET response includes updatedAt timestamp
 *   GET returns 404 for expired job
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
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4078;
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
    deviceId: "test-device-create-job-get",
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

const seedJob = async (
  overrides: Partial<{
    status: string;
    result: string | null;
    error: string | null;
    expiresAt: Date | null;
    ownerAccountId: string;
  }> = {},
) => {
  return prisma.createJob.create({
    data: {
      status: overrides.status as "pending",
      input: JSON.stringify({ text: "test", joinUrl: "https://example.com" }),
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

describe("GET /api/v2/agent-templates/create-job/:jobId", () => {
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

  // GET returns job status
  test("returns 200 with jobId, status, and createdAt for existing job", async () => {
    const job = await seedJob();
    const response = await getJobStatus(job.id, await jwtHeaders());

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.jobId).toBe(job.id);
    expect(body.status).toBe("pending");
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
  });

  // GET returns 404 for nonexistent jobId
  test("returns 404 for nonexistent jobId", async () => {
    const response = await getJobStatus(
      "00000000-0000-0000-0000-000000000000",
      await jwtHeaders(),
    );

    expect(response.status).toBe(404);
  });

  // GET returns 401 without auth
  test("returns 401 without auth", async () => {
    const job = await seedJob();
    const response = await getJobStatus(job.id, {
      "Content-Type": "application/json",
    });

    expect(response.status).toBe(401);
  });

  // GET returns 404 for another account's job
  test("returns 404 when accessing another account's job", async () => {
    // Create a second account
    const otherAccount = await prisma.account.create({ data: {} });
    // Create a job owned by the other account
    const job = await seedJob({ ownerAccountId: otherAccount.id });

    try {
      // Access with ADMIN_ACCOUNT_ID auth (JWT without accountId → ADMIN)
      const response = await getJobStatus(job.id, await jwtHeaders());
      expect(response.status).toBe(404);
    } finally {
      await prisma.createJob.deleteMany({
        where: { ownerAccountId: otherAccount.id },
      });
      await prisma.account.delete({ where: { id: otherAccount.id } });
    }
  });

  // GET response includes result when status is done
  test("includes result when status is done", async () => {
    const resultData = {
      templateId: "00000000-0000-4000-8000-000000000123",
      provisioningInstanceId: "inst-456",
      conversationId: "conv-789",
      inboxId: "inbox-012",
    };
    const job = await seedJob({
      status: "done",
      result: JSON.stringify(resultData),
    });

    const response = await getJobStatus(job.id, await jwtHeaders());
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.status).toBe("done");
    expect(body.result).toEqual(resultData);
  });

  // GET response includes error when status is failed
  test("includes error when status is failed", async () => {
    const job = await seedJob({
      status: "failed",
      error: "Template generation failed",
    });

    const response = await getJobStatus(job.id, await jwtHeaders());
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.status).toBe("failed");
    expect(body.error).toBe("Template generation failed");
  });

  // GET response omits result when status is not done
  test("omits result for non-done statuses", async () => {
    for (const status of ["pending", "generating", "provisioning"]) {
      const job = await seedJob({ status });
      const response = await getJobStatus(job.id, await jwtHeaders());
      const body = (await response.json()) as Record<string, unknown>;

      expect(body.result).toBeUndefined();
    }
  });

  // GET response omits error when status is not failed
  test("omits error for non-failed statuses", async () => {
    for (const status of ["pending", "generating", "provisioning", "done"]) {
      const job = await seedJob({
        status,
        result: status === "done" ? JSON.stringify({ templateId: "t1" }) : null,
      });
      const response = await getJobStatus(job.id, await jwtHeaders());
      const body = (await response.json()) as Record<string, unknown>;

      expect(body.error).toBeUndefined();
    }
  });

  // GET supports wait_ms for long-polling
  test("wait_ms waits for job status change", async () => {
    // Create a generating job
    const job = await seedJob({ status: "generating" });

    // Start a long-poll request with short wait
    const start = Date.now();
    const response = await getJobStatus(
      job.id,
      await jwtHeaders(),
      "wait_ms=500",
    );
    const elapsed = Date.now() - start;

    // Should take at least ~500ms (the polling interval)
    // but might return faster if the polling catches the status
    expect(response.status).toBe(200);
    // Allow some margin for test flakiness
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });

  // GET caps wait_ms at 45,000ms
  // Tested indirectly — we can't wait 45s in a test, but we verify the
  // cap is applied by checking the validation logic

  test("wait_ms above 45000ms cap is accepted (clamped, not rejected)", async () => {
    // Seed a terminal job so the handler returns immediately rather than
    // actually polling for the (clamped) deadline. The point is to verify
    // the clamp path accepts the input without 400ing — if validation
    // regressed to reject anything > MAX_WAIT_MS, this would 400.
    const job = await seedJob({ status: "done" });
    const start = Date.now();
    const response = await getJobStatus(
      job.id,
      await jwtHeaders(),
      "wait_ms=999999",
    );
    const elapsed = Date.now() - start;

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("done");
    expect(elapsed).toBeLessThan(1000);
  });

  // GET with wait_ms=0 returns immediately
  test("wait_ms=0 returns immediately", async () => {
    const job = await seedJob({ status: "pending" });
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

  // GET with wait_ms returns immediately when terminal
  test("wait_ms returns immediately when job is already terminal", async () => {
    const job = await seedJob({
      status: "done",
      result: JSON.stringify({ templateId: "t1" }),
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

  // GET with negative wait_ms returns 400
  test("returns 400 for negative wait_ms", async () => {
    const job = await seedJob();
    const response = await getJobStatus(
      job.id,
      await jwtHeaders(),
      "wait_ms=-1",
    );

    expect(response.status).toBe(400);
  });

  // GET with non-numeric wait_ms returns 400
  test("returns 400 for non-numeric wait_ms", async () => {
    const job = await seedJob();
    const response = await getJobStatus(
      job.id,
      await jwtHeaders(),
      "wait_ms=abc",
    );

    expect(response.status).toBe(400);
  });

  // GET response includes updatedAt timestamp
  test("includes updatedAt timestamp", async () => {
    const job = await seedJob();
    const response = await getJobStatus(job.id, await jwtHeaders());
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.updatedAt).toBeDefined();
    expect(typeof body.updatedAt).toBe("string");
    // Should be a valid ISO date
    const updatedAtStr = body.updatedAt as string;
    expect(new Date(updatedAtStr).toISOString()).toBe(updatedAtStr);
  });

  // GET returns 404 for expired job
  test("returns 404 for expired job", async () => {
    // Create a done job with expiresAt in the past
    const job = await seedJob({
      status: "done",
      result: JSON.stringify({ templateId: "t1" }),
      expiresAt: new Date(Date.now() - 1000), // 1 second ago
    });

    const response = await getJobStatus(job.id, await jwtHeaders());
    expect(response.status).toBe(404);
  });

  // ── Done job includes template and instance details
  test("done job result includes template and instance details", async () => {
    const resultData = {
      templateId: "00000000-0000-4000-8000-000000000abc",
      provisioningInstanceId: "inst-456",
      conversationId: "conv-789",
      inboxId: "inbox-012",
    };
    const job = await seedJob({
      status: "done",
      result: JSON.stringify(resultData),
    });

    const response = await getJobStatus(job.id, await jwtHeaders());
    const body = (await response.json()) as Record<string, unknown>;
    const result = body.result as Record<string, unknown>;

    expect(result.templateId).toBe("00000000-0000-4000-8000-000000000abc");
    expect(result.provisioningInstanceId).toBe("inst-456");
    expect(result.conversationId).toBe("conv-789");
    expect(result.inboxId).toBe("inbox-012");
  });

  // ── Failed job with joinFailureReason
  test("failed job error includes descriptive message", async () => {
    const job = await seedJob({
      status: "failed",
      error: "Provisioning join failed: Instance rejected the invitation",
    });

    const response = await getJobStatus(job.id, await jwtHeaders());
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.error).toContain("Provisioning join failed");
  });
});
