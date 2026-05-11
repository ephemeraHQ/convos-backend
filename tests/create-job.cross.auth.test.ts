/**
 * Cross-area auth tests for create-job — multi-user isolation and auth consistency.
 *
 * Covers:
 *   VAL-CJ-CROSS-006: Multiple users can create and poll jobs simultaneously
 *   VAL-CJ-CROSS-011: Authentication works consistently across POST and GET
 */

/* eslint-disable @typescript-eslint/require-await */

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
import {
  __resetJobExecutorForTests,
  __setPollIntervalMsForTests,
} from "@/api/v2/agent-templates/services/job-executor";
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import {
  __resetProvisioningClientForTests,
  type CreateAssistantOpts,
} from "@/api/v2/agent-templates/services/provisioningClient";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "@/api/v2/agent-templates/services/templateGen";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4085;
const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";
const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;

const MOCK_TEMPLATE: GeneratedTemplate = {
  agentName: "Math Tutor",
  description: "A helpful math tutor",
  prompt: "You are a helpful math tutor.",
  category: "Superpowers",
  emoji: "🧮",
  tools: ["Search"],
  connections: [],
};

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
    deviceId: "test-device-create-job-auth",
    accountId,
  }),
});

const agentKeyHeaders = () => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
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

const getJobStatus = async (
  jobId: string,
  headers: Record<string, string>,
  query?: string,
) =>
  fetch(
    `${baseURL}/api/v2/agent-templates/create-job/${jobId}${query ? `?${query}` : ""}`,
    { headers },
  );

const cleanupJobs = async (...accountIds: string[]) => {
  for (const id of accountIds) {
    await prisma.createJob.deleteMany({ where: { ownerAccountId: id } });
  }
};

const cleanupTemplates = async (...accountIds: string[]) => {
  for (const id of accountIds) {
    await prisma.agentTemplate.deleteMany({ where: { ownerAccountId: id } });
  }
};

// ---------------------------------------------------------------------------
// Mock installation
// ---------------------------------------------------------------------------

function installHappyPathMocks(): void {
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: MOCK_TEMPLATE,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );

  __resetProvisioningClientForTests({
    createAssistant: (_opts: CreateAssistantOpts) =>
      Promise.resolve({ instanceId: "inst-auth-123" }),
    getAssistant: async (instanceId: string) => ({
      instanceId,
      joinStatus: "joined" as const,
      inboxId: "inbox-auth-456",
      conversationId: "conv-auth-789",
      createdAt: new Date().toISOString(),
    }),
  });
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

describe("CreateJob Cross-Area Auth", () => {
  let otherAccount: { id: string };

  beforeAll(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
    __resetJobExecutorForTests(null);
    __resetPostHogForTests(() => {}); // no-op stub
    __setPollIntervalMsForTests(50);

    // Create a second test account
    otherAccount = await prisma.account.create({ data: {} });

    await new Promise<void>((resolve) => {
      server = app.listen(TEST_PORT, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    __resetJobExecutorForTests(null);
    __resetGenerateTemplateForTests(null);
    __resetProvisioningClientForTests(null);
    __resetPostHogForTests(null);
    __setPollIntervalMsForTests(null);

    if (originalAgentAssetsApiKey === undefined) {
      delete process.env.AGENT_ASSETS_API_KEY;
    } else {
      process.env.AGENT_ASSETS_API_KEY = originalAgentAssetsApiKey;
    }

    await cleanupJobs(ADMIN_ACCOUNT_ID, otherAccount.id);
    await cleanupTemplates(ADMIN_ACCOUNT_ID, otherAccount.id);
    await prisma.account.delete({ where: { id: otherAccount.id } });

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
    __resetGenerateTemplateForTests(null);
    __resetProvisioningClientForTests(null);
    await cleanupJobs(ADMIN_ACCOUNT_ID, otherAccount.id);
    await cleanupTemplates(ADMIN_ACCOUNT_ID, otherAccount.id);
  });

  // ── VAL-CJ-CROSS-006: Multiple users can create and poll jobs simultaneously ──

  test("CROSS-006: multiple users create jobs and each can only see their own", async () => {
    installHappyPathMocks();

    // User A: JWT with ADMIN_ACCOUNT_ID (no explicit accountId in JWT → falls back to ADMIN)
    const userAHeaders = await jwtHeaders();
    // User B: JWT with otherAccount.id
    const userBHeaders = await jwtHeaders(otherAccount.id);

    // Both users POST a create-job
    const [postResA, postResB] = await Promise.all([
      postCreateJob(
        {
          text: "User A tutor",
          joinUrl: "xmtp:https://relay.example.com/join-a",
        },
        userAHeaders,
      ),
      postCreateJob(
        {
          text: "User B tutor",
          joinUrl: "xmtp:https://relay.example.com/join-b",
        },
        userBHeaders,
      ),
    ]);

    expect(postResA.status).toBe(202);
    expect(postResB.status).toBe(202);

    const bodyA = (await postResA.json()) as { jobId: string };
    const bodyB = (await postResB.json()) as { jobId: string };

    // Different job IDs
    expect(bodyA.jobId).not.toBe(bodyB.jobId);

    // User A can see their own job
    const getResA = await getJobStatus(
      bodyA.jobId,
      userAHeaders,
      "wait_ms=5000",
    );
    expect(getResA.status).toBe(200);
    const getBodyA = (await getResA.json()) as { status: string };
    expect(getBodyA.status).toBe("done");

    // User B can see their own job
    const getResB = await getJobStatus(
      bodyB.jobId,
      userBHeaders,
      "wait_ms=5000",
    );
    expect(getResB.status).toBe(200);
    const getBodyB = (await getResB.json()) as { status: string };
    expect(getBodyB.status).toBe("done");

    // User A CANNOT see User B's job → 404
    const crossResAB = await getJobStatus(bodyB.jobId, userAHeaders);
    expect(crossResAB.status).toBe(404);

    // User B CANNOT see User A's job → 404
    const crossResBA = await getJobStatus(bodyA.jobId, userBHeaders);
    expect(crossResBA.status).toBe(404);

    // Verify jobs are owned by different accounts in DB
    const jobA = await prisma.createJob.findUnique({
      where: { id: bodyA.jobId },
    });
    const jobB = await prisma.createJob.findUnique({
      where: { id: bodyB.jobId },
    });
    expect(jobA!.ownerAccountId).not.toBe(jobB!.ownerAccountId);
  });

  // ── VAL-CJ-CROSS-011: Authentication works consistently across POST and GET ──

  test("CROSS-011a: JWT auth works for both POST and GET", async () => {
    installHappyPathMocks();
    const headers = await jwtHeaders();

    // POST with JWT
    const postRes = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      headers,
    );
    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { jobId: string };

    // GET the same job with the same JWT
    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { status: string };
    expect(getBody.status).toBe("done");
  });

  test("CROSS-011b: API key auth works for both POST and GET", async () => {
    installHappyPathMocks();
    const headers = agentKeyHeaders();

    // POST with API key
    const postRes = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      headers,
    );
    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { jobId: string };

    // GET the same job with the same API key
    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { status: string };
    expect(getBody.status).toBe("done");
  });

  test("CROSS-011c: different account JWT cannot GET job created by API key", async () => {
    installHappyPathMocks();

    // POST with API key (owner = ADMIN_ACCOUNT_ID)
    const postRes = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      agentKeyHeaders(),
    );
    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { jobId: string };

    // GET with a different account's JWT → 404 (owner mismatch)
    const otherHeaders = await jwtHeaders(otherAccount.id);
    const getRes = await getJobStatus(postBody.jobId, otherHeaders);
    expect(getRes.status).toBe(404);
  });

  test("CROSS-011d: JWT for one account cannot GET job owned by another account", async () => {
    installHappyPathMocks();

    // POST with a JWT for otherAccount
    const otherHeaders = await jwtHeaders(otherAccount.id);
    const postRes = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      otherHeaders,
    );
    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { jobId: string };

    // GET with ADMIN's JWT → 404 (owner mismatch)
    const adminHeaders = await jwtHeaders();
    const getRes = await getJobStatus(postBody.jobId, adminHeaders);
    expect(getRes.status).toBe(404);
  });

  test("CROSS-011e: no auth returns 401 on both POST and GET", async () => {
    // POST without auth → 401
    const postRes = await postCreateJob(
      { text: "test", joinUrl: "https://example.com/join" },
      { "Content-Type": "application/json" },
    );
    expect(postRes.status).toBe(401);

    // GET without auth → 401
    const getRes = await getJobStatus("some-job-id", {
      "Content-Type": "application/json",
    });
    expect(getRes.status).toBe(401);
  });
});
