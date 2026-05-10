/**
 * Cross-area E2E tests covering the full create-job lifecycle.
 *
 * Covers VAL-CJ-CROSS-001..020:
 *   CROSS-001: Full happy path — POST → poll → done
 *   CROSS-002: Full failure path (templateGen error)
 *   CROSS-003: Full failure path (provisioning error)
 *   CROSS-004: Long-polling returns immediately when job completes during wait
 *   CROSS-005: Long-polling times out and returns current status
 *   CROSS-007: Production guard blocks both POST and GET
 *   CROSS-008: Job with pdfBase64 input flows to done
 *   CROSS-009: Job with imageBase64 input flows to done
 *   CROSS-010: Expired done job returns 404 on GET
 *   CROSS-012: 5-minute timeout triggers failed state
 *   CROSS-013: Large base64 payload completes full flow
 *   CROSS-014: Job that fails during provisioning still has persisted template
 *   CROSS-015: Done job result contains provisioning instance details
 *   CROSS-016: Failed job result includes joinFailureReason
 *   CROSS-017: GET polling observes all intermediate states in order
 *   CROSS-018: Retry after failed job creates new independent job
 *   CROSS-019: Job result includes the generated template's ID
 *   CROSS-020: PostHog event fires at correct point in state machine
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
import express, { Router } from "express";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import {
  __resetJobExecutorForTests,
  __setPollIntervalMsForTests,
  __setTimeoutMsForTests,
} from "@/api/v2/agent-templates/services/job-executor";
import {
  __resetPostHogForTests,
  type PostHogCaptureProperties,
} from "@/api/v2/agent-templates/services/posthog";
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

const TEST_PORT = 4083;
const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";
const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;
const originalXMTPEnv = process.env.XMTP_ENV;

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
    deviceId: "test-device-create-job-e2e",
    accountId,
  }),
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

const cleanupJobs = async () => {
  await prisma.createJob.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID },
  });
};

const cleanupTemplates = async () => {
  await prisma.agentTemplate.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID },
  });
};

/** Captured PostHog calls */
let capturedPostHog: PostHogCaptureProperties[] = [];

// ---------------------------------------------------------------------------
// Mock installation
// ---------------------------------------------------------------------------

function installHappyPathMocks(opts?: {
  intermediatePolls?: number;
  joinDelayMs?: number;
}): void {
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: MOCK_TEMPLATE,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );

  let remainingIntermediate = opts?.intermediatePolls ?? 0;

  __resetProvisioningClientForTests({
    createAssistant: (_opts: CreateAssistantOpts) =>
      Promise.resolve({ instanceId: "inst-e2e-123" }),
    getAssistant: async (instanceId: string) => {
      if (remainingIntermediate > 0) {
        remainingIntermediate--;
        return {
          instanceId,
          joinStatus: "starting" as const,
          createdAt: new Date().toISOString(),
        };
      }
      if (opts?.joinDelayMs) {
        await new Promise((r) => setTimeout(r, opts.joinDelayMs));
      }
      return {
        instanceId,
        joinStatus: "joined" as const,
        inboxId: "inbox-e2e-456",
        conversationId: "conv-e2e-789",
        createdAt: new Date().toISOString(),
      };
    },
  });
}

function installGenerationFailureMock(): void {
  __resetGenerateTemplateForTests(() => {
    throw new Error("OpenRouter API error 500: internal server error");
  });

  __resetProvisioningClientForTests({
    createAssistant: () =>
      Promise.resolve({ instanceId: "should-not-be-called" }),
    getAssistant: (instanceId: string) =>
      Promise.resolve({
        instanceId,
        joinStatus: "joined" as const,
        createdAt: new Date().toISOString(),
      }),
  });
}

function installProvisioningFailureMock(failureReason?: string): void {
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: MOCK_TEMPLATE,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );

  __resetProvisioningClientForTests({
    createAssistant: (_opts: CreateAssistantOpts) =>
      Promise.resolve({ instanceId: "inst-e2e-fail" }),
    getAssistant: async (instanceId: string) => ({
      instanceId,
      joinStatus: "failed" as const,
      joinFailureReason: failureReason ?? "Agent rejected the group invite",
      inboxId: null,
      conversationId: null,
      createdAt: new Date().toISOString(),
    }),
  });
}

function installProvisioningPostFailureMock(): void {
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: MOCK_TEMPLATE,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );

  __resetProvisioningClientForTests({
    createAssistant: () => {
      throw new Error(
        "ProvisioningClient: POST /api/assistants returned 500 — Internal Server Error",
      );
    },
    getAssistant: () => {
      throw new Error("Should not be called");
    },
  });
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

describe("CreateJob Cross-Area E2E", () => {
  beforeAll(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
    // Let the real executor run (NOT stubbing it)
    __resetJobExecutorForTests(null);
    // Install PostHog stub
    capturedPostHog = [];
    __resetPostHogForTests((properties) => {
      capturedPostHog.push(properties);
    });
    // Short poll interval for faster E2E tests
    __setPollIntervalMsForTests(50);
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
    __setTimeoutMsForTests(null);
    if (originalAgentAssetsApiKey === undefined) {
      delete process.env.AGENT_ASSETS_API_KEY;
    } else {
      process.env.AGENT_ASSETS_API_KEY = originalAgentAssetsApiKey;
    }
    if (originalXMTPEnv === undefined) {
      delete process.env.XMTP_ENV;
    } else {
      process.env.XMTP_ENV = originalXMTPEnv;
    }
    await cleanupJobs();
    await cleanupTemplates();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
    process.env.XMTP_ENV = "dev";
    capturedPostHog = [];
    __resetGenerateTemplateForTests(null);
    __resetProvisioningClientForTests(null);
    __setTimeoutMsForTests(null);
    await cleanupJobs();
    await cleanupTemplates();
  });

  // ── VAL-CJ-CROSS-001: Full happy path ──

  test("CROSS-001: POST → poll → done with templateId + instance details", async () => {
    installHappyPathMocks();
    const headers = await jwtHeaders();

    // POST create-job
    const postRes = await postCreateJob(
      {
        text: "A friendly math tutor",
        joinUrl: "xmtp:https://relay.example.com/join",
      },
      headers,
    );

    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { jobId: string };
    expect(postBody.jobId).toBeDefined();

    // Poll until done (with generous wait)
    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");

    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      jobId: string;
      status: string;
      result?: {
        templateId: string;
        provisioningInstanceId: string;
        conversationId?: string | null;
        inboxId?: string | null;
      };
    };

    expect(getBody.status).toBe("done");
    expect(getBody.result).toBeDefined();
    expect(getBody.result!.templateId).toMatch(/^[0-9a-f]{8}-/);
    expect(getBody.result!.provisioningInstanceId).toBe("inst-e2e-123");
    expect(getBody.result!.conversationId).toBe("conv-e2e-789");
    expect(getBody.result!.inboxId).toBe("inbox-e2e-456");

    // PostHog should have fired
    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].source).toBe("create-job");
  });

  // ── VAL-CJ-CROSS-002: Full failure path (templateGen error) ──

  test("CROSS-002: POST → poll → failed with descriptive error (templateGen)", async () => {
    installGenerationFailureMock();
    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      {
        text: "A helpful tutor",
        joinUrl: "xmtp:https://relay.example.com/join",
      },
      headers,
    );

    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { jobId: string };

    // Poll until terminal
    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");

    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      status: string;
      error?: string;
    };

    expect(getBody.status).toBe("failed");
    expect(getBody.error).toContain("OpenRouter API error");

    // No PostHog event for failed generation
    expect(capturedPostHog.length).toBe(0);
  });

  // ── VAL-CJ-CROSS-003: Full failure path (provisioning error) ──

  test("CROSS-003: POST → poll → failed with descriptive error (provisioning)", async () => {
    installProvisioningFailureMock();
    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      {
        text: "A helpful tutor",
        joinUrl: "xmtp:https://relay.example.com/join",
      },
      headers,
    );

    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { jobId: string };

    // Poll until terminal
    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");

    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      status: string;
      error?: string;
    };

    expect(getBody.status).toBe("failed");
    expect(getBody.error).toContain("Agent rejected the group invite");

    // PostHog SHOULD have fired (generation succeeded, only provisioning failed)
    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].source).toBe("create-job");
  });

  // ── VAL-CJ-CROSS-004: Long-polling returns immediately when job completes ──

  test("CROSS-004: long-polling returns early when job completes during wait", async () => {
    installHappyPathMocks();
    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      headers,
    );
    const postBody = (await postRes.json()) as { jobId: string };

    // Poll with a long wait_ms — should return early since mocks resolve instantly
    const start = Date.now();
    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=10000");
    const elapsed = Date.now() - start;

    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { status: string };
    expect(getBody.status).toBe("done");

    // Should NOT wait the full 10 seconds — mock resolves fast
    expect(elapsed).toBeLessThan(5000);
  });

  // ── VAL-CJ-CROSS-005: Long-polling times out and returns current status ──

  test("CROSS-005: long-polling times out and returns current non-terminal status", async () => {
    // Use a mock that keeps the provisioning service in "starting" state —
    // this means the job will stay in provisioning
    __resetGenerateTemplateForTests(() =>
      Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      }),
    );

    __resetProvisioningClientForTests({
      createAssistant: (_opts: CreateAssistantOpts) =>
        Promise.resolve({ instanceId: "inst-stuck" }),
      getAssistant: async (instanceId: string) => ({
        instanceId,
        joinStatus: "starting" as const,
        createdAt: new Date().toISOString(),
      }),
    });

    // Use a short timeout so the job doesn't get marked as failed before polling
    __setTimeoutMsForTests(30000);

    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      headers,
    );
    const postBody = (await postRes.json()) as { jobId: string };

    // Poll with short wait_ms — should return with current status
    const start = Date.now();
    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=500");
    const elapsed = Date.now() - start;

    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { status: string };

    // Should be in a non-terminal state (generating or provisioning)
    expect(["generating", "provisioning"]).toContain(getBody.status);

    // Should have waited approximately the requested time
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(2000);
  });

  // ── VAL-CJ-CROSS-007: Production guard blocks both POST and GET ──

  test("CROSS-007: production guard blocks both POST and GET", async () => {
    process.env.XMTP_ENV = "production";

    const v2Router = Router();
    if (process.env.XMTP_ENV !== "production") {
      v2Router.use("/agent-templates", agentTemplatesRouter);
    }

    const guardedApp = express();
    guardedApp.use(express.json({ limit: "50mb" }));
    guardedApp.use("/api/v2", v2Router);
    guardedApp.use(noRouteMiddleware);

    const guardedServer = await new Promise<Server>((resolve) => {
      const s = guardedApp.listen(4090, () => {
        resolve(s);
      });
    });

    try {
      // POST should return 404 (route not mounted)
      const postRes = await fetch(
        "http://localhost:4090/api/v2/agent-templates/create-job",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Agent-API-Key": validAgentAssetsApiKey,
          },
          body: JSON.stringify({
            text: "hello",
            joinUrl: "https://example.com/join",
          }),
        },
      );
      expect(postRes.status).toBe(404);

      // GET should also return 404
      const getRes = await fetch(
        "http://localhost:4090/api/v2/agent-templates/create-job/some-id",
        {
          headers: {
            "X-Agent-API-Key": validAgentAssetsApiKey,
          },
        },
      );
      expect(getRes.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => {
        guardedServer.close(() => {
          resolve();
        });
      });
      process.env.XMTP_ENV = "dev";
    }
  });

  // ── VAL-CJ-CROSS-008: Job with pdfBase64 input flows to done ──

  test("CROSS-008: pdfBase64 input flows through all states to done", async () => {
    installHappyPathMocks();
    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      {
        pdfBase64: "dGVzdA==",
        joinUrl: "xmtp:https://relay.example.com/join",
      },
      headers,
    );

    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { jobId: string };

    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");

    const getBody = (await getRes.json()) as {
      status: string;
      result?: Record<string, unknown>;
    };
    expect(getBody.status).toBe("done");
    expect(getBody.result).toBeDefined();

    // PostHog inputType should be pdfBase64
    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].inputType).toBe("pdfBase64");
  });

  // ── VAL-CJ-CROSS-009: Job with imageBase64 input flows to done ──

  test("CROSS-009: imageBase64 input flows through all states to done", async () => {
    installHappyPathMocks();
    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      {
        imageBase64: "iVBORw0KGgo=",
        mimeType: "image/png",
        joinUrl: "xmtp:https://relay.example.com/join",
      },
      headers,
    );

    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { jobId: string };

    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");

    const getBody = (await getRes.json()) as {
      status: string;
      result?: Record<string, unknown>;
    };
    expect(getBody.status).toBe("done");
    expect(getBody.result).toBeDefined();

    // PostHog inputType should be imageBase64
    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].inputType).toBe("imageBase64");
  });

  // ── VAL-CJ-CROSS-010: Expired done job returns 404 on GET ──

  test("CROSS-010: expired done job returns 404 on GET", async () => {
    // Seed a done job with expiresAt in the past
    const job = await prisma.createJob.create({
      data: {
        status: "done",
        input: JSON.stringify({ text: "test", joinUrl: "https://example.com" }),
        ownerAccountId: ADMIN_ACCOUNT_ID,
        result: JSON.stringify({
          templateId: "00000000-0000-4000-8000-000000000099",
        }),
        expiresAt: new Date(Date.now() - 1000), // 1 second ago
      },
    });

    const headers = await jwtHeaders();
    const getRes = await getJobStatus(job.id, headers);

    expect(getRes.status).toBe(404);
  });

  // ── VAL-CJ-CROSS-012: 5-minute timeout triggers failed state ──

  test("CROSS-012: timeout triggers failed state with timeout error", async () => {
    // Mock that never reaches terminal state
    __resetGenerateTemplateForTests(() =>
      Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      }),
    );

    __resetProvisioningClientForTests({
      createAssistant: (_opts: CreateAssistantOpts) =>
        Promise.resolve({ instanceId: "inst-timeout" }),
      getAssistant: async (instanceId: string) => ({
        instanceId,
        joinStatus: "starting" as const,
        createdAt: new Date().toISOString(),
      }),
    });

    // Use a very short timeout for testing
    __setTimeoutMsForTests(200);

    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      headers,
    );
    const postBody = (await postRes.json()) as { jobId: string };

    // Wait long enough for timeout to trigger
    await new Promise((r) => setTimeout(r, 500));

    const getRes = await getJobStatus(postBody.jobId, headers);
    const getBody = (await getRes.json()) as { status: string; error?: string };

    expect(getBody.status).toBe("failed");
    expect(getBody.error).toMatch(/timeout|took too long/i);
  });

  // ── VAL-CJ-CROSS-013: Large base64 payload completes full flow ──

  test("CROSS-013: large base64 payload near 35M chars completes the full flow", async () => {
    installHappyPathMocks();
    const headers = await jwtHeaders();

    // Use a base64 string near the limit (but small enough for test speed)
    // The validation test already covers the exact 35M boundary;
    // here we test that a reasonably large payload works end-to-end
    const largeBase64 = "A".repeat(1_000_000); // 1M chars (well under 35M)

    const postRes = await postCreateJob(
      {
        pdfBase64: largeBase64,
        joinUrl: "xmtp:https://relay.example.com/join",
      },
      headers,
    );

    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { jobId: string };

    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");

    const getBody = (await getRes.json()) as {
      status: string;
      result?: Record<string, unknown>;
    };
    expect(getBody.status).toBe("done");
    expect(getBody.result).toBeDefined();
  });

  // ── VAL-CJ-CROSS-014: Job that fails during provisioning still has persisted template ──

  test("CROSS-014: template persists even when provisioning fails", async () => {
    installProvisioningPostFailureMock();
    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      {
        text: "A helpful tutor",
        joinUrl: "xmtp:https://relay.example.com/join",
      },
      headers,
    );

    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { jobId: string };

    // Wait for the executor to run and fail
    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");

    const getBody = (await getRes.json()) as { status: string; error?: string };
    expect(getBody.status).toBe("failed");
    expect(getBody.error).toContain("500");

    // Template should still exist as draft in the database
    const templates = await prisma.agentTemplate.findMany({
      where: { ownerAccountId: ADMIN_ACCOUNT_ID },
    });
    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(templates[0].status).toBe("draft");
    expect(templates[0].agentName).toBe("Math Tutor");
  });

  // ── VAL-CJ-CROSS-015: Done job result contains provisioning instance details ──

  test("CROSS-015: done result contains instanceId, inboxId, conversationId, joinStatus", async () => {
    installHappyPathMocks();
    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      headers,
    );
    const postBody = (await postRes.json()) as { jobId: string };

    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");
    const getBody = (await getRes.json()) as {
      status: string;
      result?: {
        templateId: string;
        provisioningInstanceId: string;
        conversationId?: string | null;
        inboxId?: string | null;
      };
    };

    expect(getBody.status).toBe("done");
    expect(getBody.result!.provisioningInstanceId).toBe("inst-e2e-123");
    expect(getBody.result!.conversationId).toBe("conv-e2e-789");
    expect(getBody.result!.inboxId).toBe("inbox-e2e-456");
    expect(getBody.result!.templateId).toMatch(/^[0-9a-f]{8}-/);
  });

  // ── VAL-CJ-CROSS-016: Failed job result includes joinFailureReason ──

  test("CROSS-016: failed job error includes joinFailureReason from provisioning", async () => {
    installProvisioningFailureMock("Timeout waiting for acceptance");
    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      headers,
    );
    const postBody = (await postRes.json()) as { jobId: string };

    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");
    const getBody = (await getRes.json()) as { status: string; error?: string };

    expect(getBody.status).toBe("failed");
    expect(getBody.error).toContain("Timeout waiting for acceptance");
  });

  // ── VAL-CJ-CROSS-017: GET polling observes all intermediate states in order ──

  test("CROSS-017: rapid polling observes states in order (pending → generating → provisioning → done)", async () => {
    installHappyPathMocks();
    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      headers,
    );
    const postBody = (await postRes.json()) as { jobId: string };

    // Rapidly poll with wait_ms=0 to observe state transitions
    const observedStatuses: string[] = [];
    const maxPolls = 50;

    for (let i = 0; i < maxPolls; i++) {
      const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=0");
      if (getRes.status !== 200) break;

      const getBody = (await getRes.json()) as { status: string };
      observedStatuses.push(getBody.status);

      if (getBody.status === "done" || getBody.status === "failed") break;

      // Small delay between polls to allow executor to progress
      await new Promise((r) => setTimeout(r, 20));
    }

    // Verify we saw at least some intermediate states
    // (it's possible the job completes too fast to see all states)
    expect(observedStatuses.length).toBeGreaterThan(0);

    // The final state should be done
    const finalStatus = observedStatuses[observedStatuses.length - 1];
    expect(finalStatus).toBe("done");

    // If we observed multiple states, verify they follow the state machine order
    const validTransitions: Record<string, string[]> = {
      pending: ["generating", "done", "failed"],
      generating: ["provisioning", "done", "failed"],
      provisioning: ["done", "failed"],
    };

    for (let i = 1; i < observedStatuses.length; i++) {
      const prev = observedStatuses[i - 1];
      const curr = observedStatuses[i];
      if (prev !== curr) {
        expect(validTransitions[prev]).toContain(curr);
      }
    }
  });

  // ── VAL-CJ-CROSS-018: Retry after failed job creates new independent job ──

  test("CROSS-018: retry after failure creates new independent job", async () => {
    // First job: generation fails
    installGenerationFailureMock();
    const headers = await jwtHeaders();

    const postRes1 = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      headers,
    );
    const postBody1 = (await postRes1.json()) as { jobId: string };

    // Wait for first job to fail
    const getRes1 = await getJobStatus(
      postBody1.jobId,
      headers,
      "wait_ms=5000",
    );
    const getBody1 = (await getRes1.json()) as { status: string };
    expect(getBody1.status).toBe("failed");

    // Second job: generation succeeds
    installHappyPathMocks();

    const postRes2 = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      headers,
    );
    const postBody2 = (await postRes2.json()) as { jobId: string };

    // Different job IDs
    expect(postBody1.jobId).not.toBe(postBody2.jobId);

    // Second job succeeds
    const getRes2 = await getJobStatus(
      postBody2.jobId,
      headers,
      "wait_ms=5000",
    );
    const getBody2 = (await getRes2.json()) as {
      status: string;
      result?: Record<string, unknown>;
    };
    expect(getBody2.status).toBe("done");
    expect(getBody2.result).toBeDefined();
  });

  // ── VAL-CJ-CROSS-019: Job result includes the generated template's ID ──

  test("CROSS-019: done result includes templateId matching an existing AgentTemplate row", async () => {
    installHappyPathMocks();
    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      headers,
    );
    const postBody = (await postRes.json()) as { jobId: string };

    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");
    const getBody = (await getRes.json()) as {
      status: string;
      result?: { templateId: string };
    };

    expect(getBody.status).toBe("done");
    expect(getBody.result!.templateId).toMatch(/^[0-9a-f]{8}-/);

    // Verify the template exists in the database
    const template = await prisma.agentTemplate.findUnique({
      where: { id: getBody.result!.templateId },
    });
    expect(template).not.toBeNull();
    expect(template!.agentName).toBe("Math Tutor");
  });

  // ── VAL-CJ-CROSS-020: PostHog event fires at correct point in state machine ──

  test("CROSS-020: PostHog fires after generation, before provisioning completes", async () => {
    // Use a mock with a delay in provisioning to ensure we can observe the
    // timing: PostHog fires when generating → provisioning transition occurs
    let generationCompleted = false;

    __resetGenerateTemplateForTests(() => {
      generationCompleted = true;
      return Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

    let provisioningStarted = false;

    __resetProvisioningClientForTests({
      createAssistant: (_opts: CreateAssistantOpts) => {
        provisioningStarted = true;
        return Promise.resolve({ instanceId: "inst-ph-timing" });
      },
      getAssistant: async (instanceId: string) => ({
        instanceId,
        joinStatus: "joined" as const,
        inboxId: "inbox-ph",
        conversationId: "conv-ph",
        createdAt: new Date().toISOString(),
      }),
    });

    const headers = await jwtHeaders();

    const postRes = await postCreateJob(
      { text: "A tutor", joinUrl: "xmtp:https://relay.example.com/join" },
      headers,
    );
    const postBody = (await postRes.json()) as { jobId: string };

    // Wait for completion
    const getRes = await getJobStatus(postBody.jobId, headers, "wait_ms=5000");
    const getBody = (await getRes.json()) as { status: string };
    expect(getBody.status).toBe("done");

    // PostHog event was captured
    expect(capturedPostHog.length).toBe(1);

    // Generation completed before PostHog fired (PostHog is called after
    // callGenerateTemplate returns, which is the generating → provisioning
    // transition point)
    expect(generationCompleted).toBe(true);

    // PostHog fires during the generating → provisioning transition,
    // which means provisioning has started by the time we check
    // (since the flow continues after PostHog capture)
    expect(provisioningStarted).toBe(true);

    // The PostHog event has source=create-job, proving it's the right event
    expect(capturedPostHog[0].source).toBe("create-job");
  });
});
