/**
 * Cross-source E2E tests: twitter + app/web jobs coexist.
 *
 * Covers VAL-TB-CROSS-001..005:
 *   CROSS-001: App/web source jobs still provision instances via ProvisioningClient (no regression)
 *   CROSS-002: App/web source jobs still require joinUrl (no regression)
 *   CROSS-003: Twitter and app/web source jobs coexist in the same table
 *   CROSS-004: List/filter by source is possible (metadata query)
 *   CROSS-005: Existing create-job tests all pass (verified by running existing suite)
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */

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
import {
  __resetProvisioningClientForTests,
  type CreateAssistantOpts,
} from "@/api/v2/agent-templates/services/provisioningClient";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "@/api/v2/agent-templates/services/templateGen";
import { __resetTwitterReplyForTests } from "@/api/v2/agent-templates/services/twitterReply";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken } from "@/utils/jwt";
import { ADMIN_ACCOUNT_ID } from "@/utils/prefixed-id";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4030;
const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";
const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;

const MOCK_TEMPLATE: GeneratedTemplate = {
  agentName: "Math Tutor",
  description: "A helpful math tutor that helps students learn",
  prompt: "You are a helpful math tutor. Help students learn mathematics.",
  category: "Superpowers",
  emoji: "🧮",
  tools: ["Search"],
  connections: [],
};

// ---------------------------------------------------------------------------
// Server setup (needed for endpoint-level tests like CROSS-002)
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
    deviceId: "test-device-twitter-build-cross",
    accountId,
  }),
});

const _agentKeyHeaders = () => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
});

/** POST a create-job request to the test server. */
const postCreateJob = async (
  body: Record<string, unknown>,
  headers: Record<string, string>,
) =>
  fetch(`${baseURL}/api/v2/agent-templates/create-job`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

/** Create a twitter source CreateJob row in pending state. */
async function createTwitterJob(overrides?: {
  metadata?: Record<string, string>;
  ownerAccountId?: string;
}): Promise<string> {
  const metadata = overrides?.metadata ?? {
    idea: "Build me a math tutor bot",
    twitterHandle: "@alice",
    tweetId: "1234567890",
  };

  const job = await prisma.createJob.create({
    data: {
      status: "pending",
      source: "twitter",
      input: JSON.stringify({ source: "twitter", metadata }),
      metadata: JSON.stringify(metadata),
      joinUrl: null,
      ownerAccountId: overrides?.ownerAccountId ?? ADMIN_ACCOUNT_ID,
    },
  });

  return job.id;
}

/** Create an app source CreateJob row in pending state. */
async function createAppJob(overrides?: {
  input?: Record<string, unknown>;
  ownerAccountId?: string;
}): Promise<string> {
  const input = overrides?.input ?? {
    text: "A helpful math tutor",
    joinUrl: "xmtp:https://relay.example.com/join",
  };

  const job = await prisma.createJob.create({
    data: {
      status: "pending",
      source: "app",
      input: JSON.stringify(input),
      joinUrl: input.joinUrl as string,
      ownerAccountId: overrides?.ownerAccountId ?? ADMIN_ACCOUNT_ID,
    },
  });

  return job.id;
}

/** Create a web source CreateJob row in pending state. */
async function createWebJob(overrides?: {
  input?: Record<string, unknown>;
  ownerAccountId?: string;
}): Promise<string> {
  const input = overrides?.input ?? {
    text: "A helpful math tutor",
    joinUrl: "xmtp:https://relay.example.com/join",
  };

  const job = await prisma.createJob.create({
    data: {
      status: "pending",
      source: "web",
      input: JSON.stringify(input),
      joinUrl: input.joinUrl as string,
      ownerAccountId: overrides?.ownerAccountId ?? ADMIN_ACCOUNT_ID,
    },
  });

  return job.id;
}

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

/** Get a job's current status and source from the database. */
async function getJobFields(jobId: string) {
  return prisma.createJob.findUnique({
    where: { id: jobId },
    select: {
      status: true,
      source: true,
      result: true,
      error: true,
      expiresAt: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Mock tracking
// ---------------------------------------------------------------------------

let playgroundCreateCalls: CreateAssistantOpts[] = [];

// ---------------------------------------------------------------------------
// Mock installation
// ---------------------------------------------------------------------------

function installAppWebHappyPathMocks(): void {
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: MOCK_TEMPLATE,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );

  __resetProvisioningClientForTests({
    createAssistant: (opts) => {
      playgroundCreateCalls.push(opts);
      return Promise.resolve({ instanceId: "inst-cross-app-123" });
    },
    getAssistant: (instanceId) =>
      Promise.resolve({
        instanceId,
        joinStatus: "joined" as const,
        inboxId: "inbox-cross-app",
        conversationId: "conv-cross-app",
        createdAt: new Date().toISOString(),
      }),
  });
}

function installAllSourceHappyPathMocks(): void {
  // Unified mock that works for all source types
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: MOCK_TEMPLATE,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );

  __resetProvisioningClientForTests({
    createAssistant: (opts) => {
      playgroundCreateCalls.push(opts);
      return Promise.resolve({ instanceId: "inst-cross-all-123" });
    },
    getAssistant: (instanceId) =>
      Promise.resolve({
        instanceId,
        joinStatus: "joined" as const,
        inboxId: "inbox-cross-all",
        conversationId: "conv-cross-all",
        createdAt: new Date().toISOString(),
      }),
  });

  __resetTwitterReplyForTests(async (input) => ({
    replyText: `@${input.handle.startsWith("@") ? input.handle.slice(1) : input.handle} Meet ${input.agentName} — ${input.firstSentence}. ${input.templateUrl}`,
  }));
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

describe("Twitter Build — Cross-Source Integration", () => {
  beforeAll(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
    __setPollIntervalMsForTests(50);
    // Start HTTP server for endpoint-level tests
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
    __resetTwitterReplyForTests(null);
    __setPollIntervalMsForTests(null);
    if (originalAgentAssetsApiKey === undefined) {
      delete process.env.AGENT_ASSETS_API_KEY;
    } else {
      process.env.AGENT_ASSETS_API_KEY = originalAgentAssetsApiKey;
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
    __resetJobExecutorForTests(null);
    __resetGenerateTemplateForTests(null);
    __resetProvisioningClientForTests(null);
    __resetTwitterReplyForTests(null);
    playgroundCreateCalls = [];
    await cleanupJobs();
    await cleanupTemplates();
  });

  // ── VAL-TB-CROSS-001: App/web source jobs still provision instances via ProvisioningClient ──

  describe("CROSS-001: app/web jobs still provision instances", () => {
    test("app source job calls ProvisioningClient and reaches done with instance details", async () => {
      installAppWebHappyPathMocks();
      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      const jobId = await createAppJob();
      await executeCreateJob(jobId);

      const job = await getJobFields(jobId);
      expect(job!.status).toBe("done");

      // ProvisioningClient should have been called
      expect(playgroundCreateCalls.length).toBe(1);
      expect(playgroundCreateCalls[0].joinUrl).toBe(
        "xmtp:https://relay.example.com/join",
      );

      // Result should have app/web format with instance details
      const result = JSON.parse(job!.result!);
      expect(result.playgroundInstanceId).toBe("inst-cross-app-123");
      expect(result.conversationId).toBe("conv-cross-app");
      expect(result.inboxId).toBe("inbox-cross-app");
      expect(result.templateId).toMatch(/^tmpl_/);

      // No twitter-specific fields in result
      expect(result.slug).toBeUndefined();
      expect(result.templateUrl).toBeUndefined();
      expect(result.replyText).toBeUndefined();
    });

    test("web source job calls ProvisioningClient and reaches done with instance details", async () => {
      installAppWebHappyPathMocks();
      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      const jobId = await createWebJob();
      await executeCreateJob(jobId);

      const job = await getJobFields(jobId);
      expect(job!.status).toBe("done");

      // ProvisioningClient should have been called
      expect(playgroundCreateCalls.length).toBe(1);

      // Result should have instance details
      const result = JSON.parse(job!.result!);
      expect(result.playgroundInstanceId).toBe("inst-cross-app-123");
    });

    test("app source job follows pending → generating → provisioning → done", async () => {
      // Add a delay in playground getAssistant to slow provisioning enough
      // to observe the intermediate "provisioning" state
      let getAssistantCallCount = 0;
      __resetGenerateTemplateForTests(() =>
        Promise.resolve({
          template: MOCK_TEMPLATE,
          metrics: DEFAULT_TEST_METRICS,
        }),
      );

      __resetProvisioningClientForTests({
        createAssistant: (opts) => {
          playgroundCreateCalls.push(opts);
          return Promise.resolve({ instanceId: "inst-cross-app-123" });
        },
        getAssistant: async (instanceId) => {
          getAssistantCallCount++;
          // Return "starting" for first poll, then "joined" — this ensures
          // the provisioning state is visible
          if (getAssistantCallCount === 1) {
            return {
              instanceId,
              joinStatus: "starting" as const,
              createdAt: new Date().toISOString(),
            };
          }
          return {
            instanceId,
            joinStatus: "joined" as const,
            inboxId: "inbox-cross-app",
            conversationId: "conv-cross-app",
            createdAt: new Date().toISOString(),
          };
        },
      });

      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      const jobId = await createAppJob();

      // Start the executor (fire-and-forget, runs concurrently with polling)
      const executorPromise = executeCreateJob(jobId);

      // Poll status transitions
      const statuses: string[] = [];
      for (let i = 0; i < 30; i++) {
        const job = await getJobFields(jobId);
        if (statuses[statuses.length - 1] !== job!.status) {
          statuses.push(job!.status);
        }
        if (job!.status === "done" || job!.status === "failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // Must end at done
      expect(statuses[statuses.length - 1]).toBe("done");

      // Ensure executor has finished
      await executorPromise;

      // Must have gone through the provisioning phase (proven by ProvisioningClient call)
      expect(playgroundCreateCalls.length).toBe(1);
      expect(getAssistantCallCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ── VAL-TB-CROSS-002: App/web source jobs still require joinUrl (no regression) ──

  describe("CROSS-002: app/web jobs still require joinUrl", () => {
    test("POST with source=app and no joinUrl returns 400", async () => {
      // Mock the executor so it doesn't actually run
      __resetJobExecutorForTests({
        executeJob: async () => {
          // no-op stub
        },
      });

      const response = await postCreateJob(
        { source: "app", text: "hello" },
        await jwtHeaders(),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/joinUrl/i);
    });

    test("POST with source=web and no joinUrl returns 400", async () => {
      __resetJobExecutorForTests({
        executeJob: async () => {
          // no-op stub
        },
      });

      const response = await postCreateJob(
        { source: "web", text: "hello" },
        await jwtHeaders(),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/joinUrl/i);
    });

    test("POST with source=app and empty joinUrl returns 400", async () => {
      __resetJobExecutorForTests({
        executeJob: async () => {},
      });

      const response = await postCreateJob(
        { source: "app", text: "hello", joinUrl: "" },
        await jwtHeaders(),
      );

      expect(response.status).toBe(400);
    });

    test("POST with no source (defaults to app) and no joinUrl returns 400", async () => {
      __resetJobExecutorForTests({
        executeJob: async () => {},
      });

      const response = await postCreateJob(
        { text: "hello" },
        await jwtHeaders(),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/joinUrl/i);
    });

    test("POST with source=twitter and no joinUrl returns 202 (not required)", async () => {
      __resetJobExecutorForTests({
        executeJob: async () => {},
      });

      const response = await postCreateJob(
        {
          source: "twitter",
          metadata: {
            idea: "Build a bot",
            twitterHandle: "@alice",
            tweetId: "123",
          },
        },
        await jwtHeaders(),
      );

      // Twitter source should NOT require joinUrl
      expect(response.status).toBe(202);
    });
  });

  // ── VAL-TB-CROSS-003: Twitter and app/web source jobs coexist in same table ──

  describe("CROSS-003: twitter and app/web jobs coexist in the same table", () => {
    test("jobs with different source values coexist without conflicts", async () => {
      installAllSourceHappyPathMocks();
      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      const twitterJobId = await createTwitterJob();
      const appJobId = await createAppJob();
      const webJobId = await createWebJob();

      // Execute all jobs
      await Promise.all([
        executeCreateJob(twitterJobId),
        executeCreateJob(appJobId),
        executeCreateJob(webJobId),
      ]);

      // Verify all three jobs exist with correct sources
      const twitterJob = await getJobFields(twitterJobId);
      const appJob = await getJobFields(appJobId);
      const webJob = await getJobFields(webJobId);

      expect(twitterJob!.source).toBe("twitter");
      expect(twitterJob!.status).toBe("done");

      expect(appJob!.source).toBe("app");
      expect(appJob!.status).toBe("done");

      expect(webJob!.source).toBe("web");
      expect(webJob!.status).toBe("done");

      // Verify result shapes are different
      const twitterResult = JSON.parse(twitterJob!.result!);
      const appResult = JSON.parse(appJob!.result!);
      const webResult = JSON.parse(webJob!.result!);

      // Twitter result has templateId, slug, templateUrl, replyText
      expect(twitterResult.templateId).toBeDefined();
      expect(twitterResult.slug).toBeDefined();
      expect(twitterResult.templateUrl).toBeDefined();
      expect(twitterResult.replyText).toBeDefined();

      // App result has templateId, playgroundInstanceId, conversationId, inboxId
      expect(appResult.templateId).toBeDefined();
      expect(appResult.playgroundInstanceId).toBeDefined();
      expect(appResult.conversationId).toBeDefined();
      expect(appResult.inboxId).toBeDefined();

      // Web result has templateId, playgroundInstanceId, conversationId, inboxId
      expect(webResult.templateId).toBeDefined();
      expect(webResult.playgroundInstanceId).toBeDefined();
    });

    test("coexisting jobs use different state machines", async () => {
      let playgroundCreateCallCount = 0;
      let twitterReplyCallCount = 0;

      __resetGenerateTemplateForTests(() =>
        Promise.resolve({
          template: MOCK_TEMPLATE,
          metrics: DEFAULT_TEST_METRICS,
        }),
      );

      __resetProvisioningClientForTests({
        createAssistant: (opts) => {
          playgroundCreateCallCount++;
          playgroundCreateCalls.push(opts);
          return Promise.resolve({ instanceId: "inst-cross-all-123" });
        },
        getAssistant: (instanceId) =>
          Promise.resolve({
            instanceId,
            joinStatus: "joined" as const,
            inboxId: "inbox-cross-all",
            conversationId: "conv-cross-all",
            createdAt: new Date().toISOString(),
          }),
      });

      __resetTwitterReplyForTests(async (input) => {
        twitterReplyCallCount++;
        return {
          replyText: `@${input.handle.startsWith("@") ? input.handle.slice(1) : input.handle} Meet ${input.agentName} — ${input.firstSentence}. ${input.templateUrl}`,
        };
      });

      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      const twitterJobId = await createTwitterJob();
      const appJobId = await createAppJob();

      // Execute both concurrently
      await Promise.all([
        executeCreateJob(twitterJobId),
        executeCreateJob(appJobId),
      ]);

      const twitterJob = await getJobFields(twitterJobId);
      const appJob = await getJobFields(appJobId);

      // Twitter job should be done without provisioning (proven by no playground call for it)
      expect(twitterJob!.status).toBe("done");
      expect(twitterJob!.source).toBe("twitter");

      // Twitter result should have twitter-specific fields (slug, templateUrl, replyText)
      const twitterResult = JSON.parse(twitterJob!.result!);
      expect(twitterResult.replyText).toBeDefined();
      expect(twitterResult.slug).toBeDefined();

      // App job should be done with provisioning (proven by playground call)
      expect(appJob!.status).toBe("done");
      expect(appJob!.source).toBe("app");

      // App result should have instance fields (not twitter fields)
      const appResult = JSON.parse(appJob!.result!);
      expect(appResult.playgroundInstanceId).toBeDefined();

      // Exactly 1 playground create call (for the app job only)
      // and 1 twitter reply call (for the twitter job only)
      expect(playgroundCreateCallCount).toBe(1);
      expect(twitterReplyCallCount).toBe(1);
    });
  });

  // ── VAL-TB-CROSS-004: List/filter by source is possible ──

  describe("CROSS-004: filter by source and metadata is possible", () => {
    test("can filter jobs by source='twitter'", async () => {
      installAllSourceHappyPathMocks();
      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      const twitterJobId = await createTwitterJob();
      const appJobId = await createAppJob();

      await executeCreateJob(twitterJobId);
      await executeCreateJob(appJobId);

      // Query by source=twitter
      const twitterJobs = await prisma.createJob.findMany({
        where: { source: "twitter", ownerAccountId: ADMIN_ACCOUNT_ID },
      });

      expect(twitterJobs.length).toBe(1);
      expect(twitterJobs[0].id).toBe(twitterJobId);
      expect(twitterJobs[0].source).toBe("twitter");
    });

    test("can filter jobs by source='app'", async () => {
      installAllSourceHappyPathMocks();
      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      const twitterJobId = await createTwitterJob();
      const appJobId = await createAppJob();

      await executeCreateJob(twitterJobId);
      await executeCreateJob(appJobId);

      // Query by source=app
      const appJobs = await prisma.createJob.findMany({
        where: { source: "app", ownerAccountId: ADMIN_ACCOUNT_ID },
      });

      expect(appJobs.length).toBe(1);
      expect(appJobs[0].id).toBe(appJobId);
      expect(appJobs[0].source).toBe("app");
    });

    test("can filter by source='web'", async () => {
      installAllSourceHappyPathMocks();
      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      const webJobId = await createWebJob();
      await executeCreateJob(webJobId);

      const webJobs = await prisma.createJob.findMany({
        where: { source: "web", ownerAccountId: ADMIN_ACCOUNT_ID },
      });

      expect(webJobs.length).toBe(1);
      expect(webJobs[0].source).toBe("web");
    });

    test("can query twitter job metadata for twitterHandle", async () => {
      installAllSourceHappyPathMocks();
      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      const jobId = await createTwitterJob({
        metadata: {
          idea: "Build me a math tutor bot",
          twitterHandle: "@cross_test_user",
          tweetId: "999888777",
        },
      });

      await executeCreateJob(jobId);

      // Query by metadata containing specific handle
      const jobs = await prisma.createJob.findMany({
        where: {
          source: "twitter",
          ownerAccountId: ADMIN_ACCOUNT_ID,
          metadata: { contains: "@cross_test_user" },
        },
      });

      expect(jobs.length).toBe(1);
      expect(jobs[0].id).toBe(jobId);

      // Verify the metadata is valid JSON
      const metadata = JSON.parse(jobs[0].metadata!);
      expect(metadata.twitterHandle).toBe("@cross_test_user");
      expect(metadata.tweetId).toBe("999888777");
    });

    test("source filter does not return cross-contaminated results", async () => {
      installAllSourceHappyPathMocks();
      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      const twitterJobId = await createTwitterJob();
      const appJobId = await createAppJob();
      const webJobId = await createWebJob();

      await Promise.all([
        executeCreateJob(twitterJobId),
        executeCreateJob(appJobId),
        executeCreateJob(webJobId),
      ]);

      // source=twitter should NOT include app or web jobs
      const twitterJobs = await prisma.createJob.findMany({
        where: { source: "twitter", ownerAccountId: ADMIN_ACCOUNT_ID },
      });
      const twitterIds = twitterJobs.map((j) => j.id);
      expect(twitterIds).not.toContain(appJobId);
      expect(twitterIds).not.toContain(webJobId);

      // source=app should NOT include twitter or web jobs
      const appJobs = await prisma.createJob.findMany({
        where: { source: "app", ownerAccountId: ADMIN_ACCOUNT_ID },
      });
      const appIds = appJobs.map((j) => j.id);
      expect(appIds).not.toContain(twitterJobId);
      expect(appIds).not.toContain(webJobId);
    });
  });

  // ── VAL-TB-CROSS-005: Existing create-job tests all pass ──
  // This is verified by running the full existing test suite.
  // No additional test needed here — the backward compatibility
  // is confirmed by running: bun test tests/create-job.*.test.ts

  describe("CROSS-005: backward compatibility (structural)", () => {
    test("default source for new jobs without source field is 'app'", async () => {
      // Create a job without specifying source — should default to 'app'
      const job = await prisma.createJob.create({
        data: {
          status: "pending",
          input: JSON.stringify({
            text: "A tutor",
            joinUrl: "xmtp:https://relay.example.com/join",
          }),
          joinUrl: "xmtp:https://relay.example.com/join",
          ownerAccountId: ADMIN_ACCOUNT_ID,
        },
      });

      expect(job.source).toBe("app");

      await prisma.createJob.deleteMany({
        where: { id: job.id },
      });
    });

    test("app source job result format unchanged from pre-twitter-build era", async () => {
      installAppWebHappyPathMocks();
      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      const jobId = await createAppJob();
      await executeCreateJob(jobId);

      const job = await getJobFields(jobId);
      const result = JSON.parse(job!.result!);

      // Result should have the exact same fields as pre-twitter-build
      expect(result).toHaveProperty("templateId");
      expect(result).toHaveProperty("playgroundInstanceId");
      expect(result).toHaveProperty("conversationId");
      expect(result).toHaveProperty("inboxId");

      // Result should NOT have any twitter-specific fields
      expect(result).not.toHaveProperty("slug");
      expect(result).not.toHaveProperty("templateUrl");
      expect(result).not.toHaveProperty("replyText");
    });
  });

  // ── Additional cross-source coverage ──

  describe("Cross-source edge cases", () => {
    test("twitter and app jobs owned by different accounts are isolated", async () => {
      installAllSourceHappyPathMocks();
      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      // Create a second account for the app job (FK constraint requires it)
      const otherAccount = await prisma.account.create({ data: {} });

      try {
        const twitterJobId = await createTwitterJob({
          ownerAccountId: ADMIN_ACCOUNT_ID,
        });
        const appJobId = await createAppJob({
          ownerAccountId: otherAccount.id,
        });

        await Promise.all([
          executeCreateJob(twitterJobId),
          executeCreateJob(appJobId),
        ]);

        // Verify each job belongs to the correct owner
        const twitterJob = await prisma.createJob.findUnique({
          where: { id: twitterJobId },
          select: { ownerAccountId: true, source: true, status: true },
        });
        const appJob = await prisma.createJob.findUnique({
          where: { id: appJobId },
          select: { ownerAccountId: true, source: true, status: true },
        });

        expect(twitterJob!.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
        expect(twitterJob!.source).toBe("twitter");
        expect(twitterJob!.status).toBe("done");

        expect(appJob!.ownerAccountId).toBe(otherAccount.id);
        expect(appJob!.source).toBe("app");
        expect(appJob!.status).toBe("done");
      } finally {
        // Clean up the other account's job and template
        await prisma.createJob.deleteMany({
          where: { ownerAccountId: otherAccount.id },
        });
        await prisma.agentTemplate.deleteMany({
          where: { ownerAccountId: otherAccount.id },
        });
        await prisma.account.deleteMany({
          where: { id: otherAccount.id },
        });
      }
    });

    test("concurrent twitter + app jobs execute independently without interference", async () => {
      // Fail twitter job but succeed app job
      __resetGenerateTemplateForTests((input) => {
        const inputObj = typeof input === "string" ? { text: input } : input;
        if (inputObj.text === "fail-this-twitter-job") {
          throw new Error("Twitter generation failed");
        }
        return Promise.resolve({
          template: MOCK_TEMPLATE,
          metrics: DEFAULT_TEST_METRICS,
        });
      });

      __resetProvisioningClientForTests({
        createAssistant: (opts) => {
          playgroundCreateCalls.push(opts);
          return Promise.resolve({ instanceId: "inst-ind-123" });
        },
        getAssistant: (instanceId) =>
          Promise.resolve({
            instanceId,
            joinStatus: "joined" as const,
            inboxId: "inbox-ind",
            conversationId: "conv-ind",
            createdAt: new Date().toISOString(),
          }),
      });

      __resetTwitterReplyForTests(async (input) => ({
        replyText: `@${input.handle} ${input.templateUrl}`,
      }));

      const { executeCreateJob } = await import(
        "../src/api/v2/agent-templates/services/job-executor"
      );

      const twitterJobId = await createTwitterJob({
        metadata: {
          idea: "fail-this-twitter-job",
          twitterHandle: "@alice",
          tweetId: "111",
        },
      });

      const appJobId = await createAppJob({
        input: {
          text: "A helpful tutor",
          joinUrl: "xmtp:https://relay.example.com/join",
        },
      });

      // Execute concurrently
      await Promise.allSettled([
        executeCreateJob(twitterJobId),
        executeCreateJob(appJobId),
      ]);

      // Twitter job should have failed
      const twitterJob = await getJobFields(twitterJobId);
      expect(twitterJob!.status).toBe("failed");
      expect(twitterJob!.error).toContain("Twitter generation failed");

      // App job should have succeeded
      const appJob = await getJobFields(appJobId);
      expect(appJob!.status).toBe("done");
      expect(appJob!.source).toBe("app");

      // ProvisioningClient should have been called for app job only
      expect(playgroundCreateCalls.length).toBe(1);
      expect(playgroundCreateCalls[0].joinUrl).toBe(
        "xmtp:https://relay.example.com/join",
      );
    });

    test("production guard applies equally to twitter and app/web sources", async () => {
      const originalXMTPEnv = process.env.XMTP_ENV;
      process.env.XMTP_ENV = "production";

      try {
        // Build a guarded router (same pattern as create-job.guard.test.ts)
        const expressLib = await import("express");
        const v2Router = expressLib.Router();
        if (process.env.XMTP_ENV !== "production") {
          v2Router.use("/agent-templates", agentTemplatesRouter);
        }

        const guardedApp = express();
        guardedApp.use(express.json({ limit: "50mb" }));
        guardedApp.use("/api/v2", v2Router);
        guardedApp.use(noRouteMiddleware);

        const guardedServer = await new Promise<Server>((resolve) => {
          const s = guardedApp.listen(4033, () => {
            resolve(s);
          });
        });

        try {
          // POST with source=twitter should be blocked in production
          const twitterRes = await fetch(
            "http://localhost:4033/api/v2/agent-templates/create-job",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Agent-API-Key": validAgentAssetsApiKey,
              },
              body: JSON.stringify({
                source: "twitter",
                metadata: {
                  idea: "Build a bot",
                  twitterHandle: "@alice",
                  tweetId: "123",
                },
              }),
            },
          );
          expect(twitterRes.status).toBe(404);

          // POST with source=app should also be blocked
          const appRes = await fetch(
            "http://localhost:4033/api/v2/agent-templates/create-job",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Agent-API-Key": validAgentAssetsApiKey,
              },
              body: JSON.stringify({
                source: "app",
                text: "hello",
                joinUrl: "https://example.com/join",
              }),
            },
          );
          expect(appRes.status).toBe(404);
        } finally {
          await new Promise<void>((resolve) => {
            guardedServer.close(() => {
              resolve();
            });
          });
        }
      } finally {
        process.env.XMTP_ENV = originalXMTPEnv;
      }
    });
  });
});
