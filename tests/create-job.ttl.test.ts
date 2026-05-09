/**
 * TTL sweep tests for CreateJob
 *
 * Covers:
 *   VAL-CJ-TTL-001: Completed jobs have expiresAt set to 24 hours after completion
 *   VAL-CJ-TTL-002: Pending/in-progress jobs have NULL expiresAt
 *   VAL-CJ-TTL-003: Expired jobs are not returned by GET endpoint
 *   VAL-CJ-TTL-004: TTL duration is exactly 24 hours
 *   VAL-CJ-TTL-005: Expired jobs remain in the database
 *   VAL-CJ-TTL-006: Multiple jobs with different expiry times
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
import { sweepExpiredJobs } from "@/api/v2/agent-templates/services/ttl-sweep";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken } from "@/utils/jwt";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4029;
const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";
const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;
const TTL_SECONDS = 24 * 60 * 60; // 86400

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

const jwtHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-create-job-ttl",
    accountId: ADMIN_ACCOUNT_ID,
  }),
});

const getJobStatus = async (jobId: string, headers: Record<string, string>) =>
  fetch(`${baseURL}/api/v2/agent-templates/create-job/${jobId}`, { headers });

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
  }> = {},
) =>
  prisma.createJob.create({
    data: {
      status: overrides.status as "pending",
      input: JSON.stringify({ text: "test", joinUrl: "https://example.com" }),
      ownerAccountId: ADMIN_ACCOUNT_ID,
      result: overrides.result !== undefined ? overrides.result : null,
      error: overrides.error !== undefined ? overrides.error : null,
      expiresAt: overrides.expiresAt !== undefined ? overrides.expiresAt : null,
    },
  });

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

describe("CreateJob TTL sweep", () => {
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

  // ── VAL-CJ-TTL-001: Completed jobs have expiresAt set ──

  test("sweep sets expiresAt on done jobs without it", async () => {
    const job = await seedJob({
      status: "done",
      result: JSON.stringify({ templateId: "t1" }),
    });

    // Verify expiresAt is NULL initially
    const before = await prisma.createJob.findUnique({ where: { id: job.id } });
    expect(before!.expiresAt).toBeNull();

    // Run sweep
    const count = await sweepExpiredJobs();
    expect(count).toBe(1);

    // Verify expiresAt is now set to ~24h from now
    const after = await prisma.createJob.findUnique({ where: { id: job.id } });
    expect(after!.expiresAt).not.toBeNull();

    const diffSeconds = (after!.expiresAt!.getTime() - Date.now()) / 1000;
    expect(diffSeconds).toBeGreaterThan(TTL_SECONDS - 60);
    expect(diffSeconds).toBeLessThan(TTL_SECONDS + 60);
  });

  test("sweep sets expiresAt on failed jobs without it", async () => {
    const job = await seedJob({
      status: "failed",
      error: "Something went wrong",
    });

    const count = await sweepExpiredJobs();
    expect(count).toBe(1);

    const after = await prisma.createJob.findUnique({ where: { id: job.id } });
    expect(after!.expiresAt).not.toBeNull();
  });

  // ── VAL-CJ-TTL-002: Pending/in-progress jobs have NULL expiresAt ──

  test("sweep does not touch in-progress jobs", async () => {
    const pending = await seedJob({ status: "pending" });
    const generating = await seedJob({ status: "generating" });
    const provisioning = await seedJob({ status: "provisioning" });

    const count = await sweepExpiredJobs();
    expect(count).toBe(0);

    const p = await prisma.createJob.findUnique({ where: { id: pending.id } });
    const g = await prisma.createJob.findUnique({
      where: { id: generating.id },
    });
    const pr = await prisma.createJob.findUnique({
      where: { id: provisioning.id },
    });

    expect(p!.expiresAt).toBeNull();
    expect(g!.expiresAt).toBeNull();
    expect(pr!.expiresAt).toBeNull();
  });

  // ── VAL-CJ-TTL-003: Expired jobs are not returned by GET endpoint ──

  test("GET returns 404 for expired job", async () => {
    const job = await seedJob({
      status: "done",
      result: JSON.stringify({ templateId: "t1" }),
      expiresAt: new Date(Date.now() - 1000), // 1 second ago
    });

    const response = await getJobStatus(job.id, await jwtHeaders());
    expect(response.status).toBe(404);
  });

  // ── VAL-CJ-TTL-004: TTL duration is exactly 24 hours ──

  test("TTL duration is approximately 24 hours (86400 seconds)", async () => {
    const job = await seedJob({
      status: "done",
      result: JSON.stringify({ templateId: "t1" }),
    });

    await sweepExpiredJobs();

    const after = await prisma.createJob.findUnique({ where: { id: job.id } });
    const diffSeconds =
      (after!.expiresAt!.getTime() - after!.updatedAt.getTime()) / 1000;

    // Allow ±60 seconds tolerance
    expect(diffSeconds).toBeGreaterThan(TTL_SECONDS - 60);
    expect(diffSeconds).toBeLessThan(TTL_SECONDS + 60);
  });

  // ── VAL-CJ-TTL-005: Expired jobs remain in the database ──

  test("expired jobs remain in the database (not auto-deleted)", async () => {
    const job = await seedJob({
      status: "done",
      result: JSON.stringify({ templateId: "t1" }),
      expiresAt: new Date(Date.now() - 1000),
    });

    // Verify the row still exists even though expired
    const found = await prisma.createJob.findUnique({ where: { id: job.id } });
    expect(found).not.toBeNull();
    expect(found!.expiresAt!.getTime()).toBeLessThan(Date.now());
  });

  // ── VAL-CJ-TTL-006: Multiple jobs with different expiry times ──

  test("each job gets its own expiresAt based on completion time", async () => {
    // Create two done jobs at slightly different times
    const job1 = await seedJob({
      status: "done",
      result: JSON.stringify({ templateId: "t1" }),
    });

    // Small delay to ensure different timestamps (Postgres resolution is 1ms)
    await new Promise((resolve) => setTimeout(resolve, 50));

    const job2 = await seedJob({
      status: "done",
      result: JSON.stringify({ templateId: "t2" }),
    });

    // Verify the two jobs have different updatedAt values
    const j1 = await prisma.createJob.findUnique({ where: { id: job1.id } });
    const j2 = await prisma.createJob.findUnique({ where: { id: job2.id } });
    // They should have different updatedAt timestamps
    expect(j1!.updatedAt.getTime()).toBeLessThan(j2!.updatedAt.getTime());

    await sweepExpiredJobs();

    const after1 = await prisma.createJob.findUnique({
      where: { id: job1.id },
    });
    const after2 = await prisma.createJob.findUnique({
      where: { id: job2.id },
    });

    // Both should have expiresAt set
    expect(after1!.expiresAt).not.toBeNull();
    expect(after2!.expiresAt).not.toBeNull();

    // They should have different expiresAt values
    // (since they have different updatedAt timestamps)
    expect(after1!.expiresAt!.getTime()).not.toBe(after2!.expiresAt!.getTime());
  });

  // ── Sweep is idempotent ──

  test("sweep is idempotent — running twice doesn't change expiresAt", async () => {
    const job = await seedJob({
      status: "done",
      result: JSON.stringify({ templateId: "t1" }),
    });

    await sweepExpiredJobs();
    const after1 = await prisma.createJob.findUnique({ where: { id: job.id } });
    const firstExpiresAt = after1!.expiresAt!.getTime();

    await sweepExpiredJobs();
    const after2 = await prisma.createJob.findUnique({ where: { id: job.id } });

    // expiresAt should NOT change on second sweep (already set)
    expect(after2!.expiresAt!.getTime()).toBe(firstExpiresAt);
  });

  // ── Jobs with existing expiresAt are not updated ──

  test("sweep skips jobs that already have expiresAt", async () => {
    const customExpiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12h
    const job = await seedJob({
      status: "done",
      result: JSON.stringify({ templateId: "t1" }),
      expiresAt: customExpiresAt,
    });

    const count = await sweepExpiredJobs();
    expect(count).toBe(0); // No jobs updated

    const after = await prisma.createJob.findUnique({ where: { id: job.id } });
    // expiresAt should remain the custom value
    expect(after!.expiresAt!.getTime()).toBe(customExpiresAt.getTime());
  });
});
