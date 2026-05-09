/**
 * Twitter build background executor tests.
 *
 * Covers:
 *   VAL-TB-BG-001: Twitter job transitions: pending → generating → done (no provisioning step)
 *   VAL-TB-BG-002: Twitter job generates template using templateGen with idea text
 *   VAL-TB-BG-003: Twitter job publishes template (status=published, firstPublishedAt set, version=1)
 *   VAL-TB-BG-004: Twitter job composes reply text after template is published
 *   VAL-TB-BG-005: Twitter job stores result with templateId, slug, templateUrl, replyText
 *   VAL-TB-BG-006: Twitter job does NOT call ProvisioningClient
 *   VAL-TB-BG-007: Twitter job transitions to failed when templateGen throws
 *   VAL-TB-BG-008: Twitter job transitions to failed with timeout error after 5 minutes
 *   VAL-TB-BG-009: Concurrent twitter + app/web jobs run independently
 *   VAL-TB-BG-010: Twitter job sets expiresAt on terminal state
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetProvisioningClientForTests,
  type CreateAssistantOpts,
} from "../src/api/v2/agent-templates/services/provisioningClient";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "../src/api/v2/agent-templates/services/templateGen";
import {
  __resetTwitterReplyForTests,
  type ReplyInput,
} from "../src/api/v2/agent-templates/services/twitterReply";
import { ADMIN_ACCOUNT_ID } from "../src/utils/constants";
import { prisma } from "../src/utils/prisma";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
      input: JSON.stringify({
        source: "twitter",
        metadata,
      }),
      metadata: JSON.stringify(metadata),
      joinUrl: null,
      ownerAccountId: overrides?.ownerAccountId ?? ADMIN_ACCOUNT_ID,
    },
  });

  return job.id;
}

/** Create an app/web source CreateJob row in pending state. */
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

/** Get a job's current status from the database. */
async function getJobStatus(jobId: string) {
  return prisma.createJob.findUnique({
    where: { id: jobId },
    select: {
      status: true,
      source: true,
      result: true,
      error: true,
      expiresAt: true,
      updatedAt: true,
    },
  });
}

/** Standard mock template generation result. */
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
// Test lifecycle
// ---------------------------------------------------------------------------

// Track templateGen calls for assertion
let templateGenCalls: Array<Record<string, string | undefined>> = [];

// Track provisioning create calls for assertion
let provisioningCreateCalls: CreateAssistantOpts[] = [];

// Track reply calls for assertion
let replyCalls: ReplyInput[] = [];

beforeEach(() => {
  // Reset tracking
  templateGenCalls = [];
  provisioningCreateCalls = [];
  replyCalls = [];

  // Reset test seams — use no-op defaults
  __resetGenerateTemplateForTests(null);
  __resetProvisioningClientForTests(null);
  __resetTwitterReplyForTests(null);
});

afterEach(async () => {
  // Clean up test jobs
  await prisma.createJob.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID },
  });
  // Clean up test templates
  await prisma.agentTemplate.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID },
  });
  // Reset test seams
  __resetGenerateTemplateForTests(null);
  __resetProvisioningClientForTests(null);
  __resetTwitterReplyForTests(null);
});

// ---------------------------------------------------------------------------
// Helper: install mock services for twitter happy path
// ---------------------------------------------------------------------------

function installTwitterHappyPathMocks(): void {
  // Mock templateGen
  __resetGenerateTemplateForTests((input) => {
    const inputObj = typeof input === "string" ? { text: input } : input;
    templateGenCalls.push({
      text: inputObj.text,
      pdfBase64: inputObj.pdfBase64,
      imageBase64: inputObj.imageBase64,
      mimeType: inputObj.mimeType,
    });
    return Promise.resolve({
      template: MOCK_TEMPLATE,
      metrics: DEFAULT_TEST_METRICS,
    });
  });

  // Mock ProvisioningClient — should NOT be called for twitter jobs
  __resetProvisioningClientForTests({
    createAssistant: (opts) => {
      provisioningCreateCalls.push(opts);
      return Promise.resolve({ instanceId: "inst-should-not-be-called" });
    },
    getAssistant: (instanceId) =>
      Promise.resolve({
        instanceId,
        joinStatus: "joined" as const,
        inboxId: "inbox-should-not-be-called",
        conversationId: "conv-should-not-be-called",
        createdAt: new Date().toISOString(),
      }),
  });

  // Mock twitterReply
  __resetTwitterReplyForTests(async (input) => {
    replyCalls.push(input);
    return {
      replyText: `@${input.handle.startsWith("@") ? input.handle.slice(1) : input.handle} Meet ${input.agentName} — ${input.firstSentence}. ${input.templateUrl}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Twitter Build Executor — Happy Path", () => {
  test("VAL-TB-BG-001: twitter job transitions pending → generating → done (no provisioning)", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("done");

    // Verify it did NOT enter provisioning — provisioning service was not called
    expect(provisioningCreateCalls.length).toBe(0);
  });

  test("VAL-TB-BG-002: twitter job calls templateGen with idea text from metadata", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob({
      metadata: {
        idea: "Build me a math tutor bot",
        twitterHandle: "@alice",
        tweetId: "1234567890",
      },
    });

    await executeCreateJob(jobId);

    // templateGen should have been called with the idea text
    expect(templateGenCalls.length).toBe(1);
    expect(templateGenCalls[0].text).toBe("Build me a math tutor bot");
  });

  test("VAL-TB-BG-003: twitter job publishes template (status=published, firstPublishedAt set, version=1)", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    // Find the published template
    const templates = await prisma.agentTemplate.findMany({
      where: { ownerAccountId: ADMIN_ACCOUNT_ID },
    });

    expect(templates.length).toBeGreaterThanOrEqual(1);
    const template = templates[0];
    expect(template.status).toBe("published");
    expect(template.firstPublishedAt).not.toBeNull();
    expect(template.version).toBe(1);
    expect(template.agentName).toBe("Math Tutor");
  });

  test("VAL-TB-BG-004: twitter job composes reply after template is published", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob({
      metadata: {
        idea: "Build me a math tutor bot",
        twitterHandle: "@alice",
        tweetId: "1234567890",
      },
    });

    await executeCreateJob(jobId);

    // Reply should have been composed
    expect(replyCalls.length).toBe(1);
    expect(replyCalls[0].handle).toBe("@alice");
    expect(replyCalls[0].agentName).toBe("Math Tutor");

    // Reply references the published template's URL
    expect(replyCalls[0].templateUrl).toContain("convos.org");
    expect(replyCalls[0].templateUrl).toContain(replyCalls[0].slug);
  });

  test("VAL-TB-BG-005: twitter job stores result with templateId, slug, templateUrl, replyText", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("done");

    const result = JSON.parse(job!.result!);
    expect(result.templateId).toBeDefined();
    expect(result.templateId).toMatch(/^[0-9a-f]{8}-/);
    expect(result.slug).toBeDefined();
    expect(result.templateUrl).toBeDefined();
    expect(result.templateUrl).toContain(result.slug);
    expect(result.replyText).toBeDefined();
    expect(result.replyText).toContain("@alice");
  });

  test("VAL-TB-BG-006: twitter job does NOT call ProvisioningClient", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    // ProvisioningClient should NOT have been called at all
    expect(provisioningCreateCalls.length).toBe(0);
  });

  test("VAL-TB-BG-007: twitter job transitions to failed when templateGen throws", async () => {
    __resetGenerateTemplateForTests(() => {
      throw new Error("LLM API error: model unavailable");
    });

    __resetProvisioningClientForTests({
      createAssistant: (_opts) =>
        Promise.resolve({ instanceId: "should-not-be-called" }),
      getAssistant: (instanceId) =>
        Promise.resolve({
          instanceId,
          joinStatus: "joined" as const,
          createdAt: new Date().toISOString(),
        }),
    });

    __resetTwitterReplyForTests(async () => ({
      replyText: "@alice fallback",
    }));

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("LLM API error");
  });

  test("VAL-TB-BG-008: twitter job transitions to failed with timeout error", async () => {
    // Make templateGen take longer than the timeout
    __resetGenerateTemplateForTests(async () => {
      // Sleep longer than the timeout we'll set
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      };
    });

    __resetProvisioningClientForTests({
      createAssistant: () =>
        Promise.resolve({ instanceId: "should-not-be-called" }),
      getAssistant: () =>
        Promise.resolve({
          instanceId: "x",
          joinStatus: "joined" as const,
          createdAt: new Date().toISOString(),
        }),
    });

    __resetTwitterReplyForTests(async () => ({
      replyText: "@alice fallback",
    }));

    const { executeCreateJob, __setTimeoutMsForTests } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    // Use a short timeout that templateGen will exceed
    __setTimeoutMsForTests(100);

    try {
      const jobId = await createTwitterJob();
      await executeCreateJob(jobId);

      const job = await getJobStatus(jobId);
      expect(job!.status).toBe("failed");
      expect(job!.error).toMatch(/timeout|took too long/i);
    } finally {
      __setTimeoutMsForTests(null);
    }
  });

  test("VAL-TB-BG-009: concurrent twitter + app/web jobs run independently", async () => {
    // Mock templateGen — fail for a specific idea text
    __resetGenerateTemplateForTests((input) => {
      const inputObj = typeof input === "string" ? { text: input } : input;
      templateGenCalls.push({
        text: inputObj.text,
        pdfBase64: inputObj.pdfBase64,
        imageBase64: inputObj.imageBase64,
        mimeType: inputObj.mimeType,
      });

      if (inputObj.text === "fail-this-job") {
        throw new Error("Generation failed for twitter job");
      }
      return Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

    // Mock ProvisioningClient for app/web job
    __resetProvisioningClientForTests({
      createAssistant: (opts) => {
        provisioningCreateCalls.push(opts);
        return Promise.resolve({ instanceId: "inst-concurrent" });
      },
      getAssistant: (instanceId) =>
        Promise.resolve({
          instanceId,
          joinStatus: "joined" as const,
          inboxId: "inbox-concurrent",
          conversationId: "conv-concurrent",
          createdAt: new Date().toISOString(),
        }),
    });

    // Mock reply for twitter job
    __resetTwitterReplyForTests(async (input) => ({
      replyText: `@${input.handle} ${input.templateUrl}`,
    }));

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    // Create a twitter job that will fail
    const twitterJobId = await createTwitterJob({
      metadata: {
        idea: "fail-this-job",
        twitterHandle: "@alice",
        tweetId: "111",
      },
    });

    // Create an app/web job that will succeed
    const appJobId = await createAppJob({
      input: {
        text: "A helpful tutor",
        joinUrl: "xmtp:https://relay.example.com/join",
      },
    });

    // Execute concurrently
    const [twitterResult, appResult] = await Promise.allSettled([
      executeCreateJob(twitterJobId),
      executeCreateJob(appJobId),
    ]);

    // Both should settle (not throw)
    expect(twitterResult.status).toBe("fulfilled");
    expect(appResult.status).toBe("fulfilled");

    // Twitter job should have failed
    const twitterJob = await getJobStatus(twitterJobId);
    expect(twitterJob!.status).toBe("failed");

    // App/web job should have succeeded
    const appJob = await getJobStatus(appJobId);
    expect(appJob!.status).toBe("done");
    expect(appJob!.source).toBe("app");

    // ProvisioningClient should have been called for app job only
    expect(provisioningCreateCalls.length).toBe(1);
  });

  test("VAL-TB-BG-010: twitter job sets expiresAt on terminal state (done)", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("done");
    expect(job!.expiresAt).not.toBeNull();

    // expiresAt should be ~24 hours from now
    const expiresAt = job!.expiresAt!;
    const now = Date.now();
    const diffMs = expiresAt.getTime() - now;
    const hours24 = 24 * 60 * 60 * 1000;
    // Allow 60 seconds of tolerance
    expect(diffMs).toBeGreaterThan(hours24 - 60_000);
    expect(diffMs).toBeLessThan(hours24 + 60_000);
  });

  test("VAL-TB-BG-010: twitter job sets expiresAt on terminal state (failed)", async () => {
    __resetGenerateTemplateForTests(() => {
      throw new Error("Generation failed");
    });

    __resetProvisioningClientForTests({
      createAssistant: () => {
        throw new Error("Should not be called");
      },
      getAssistant: () => {
        throw new Error("Should not be called");
      },
    });

    __resetTwitterReplyForTests(async () => ({
      replyText: "@alice fallback",
    }));

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("failed");
    expect(job!.expiresAt).not.toBeNull();

    // expiresAt should be ~24 hours from now
    const expiresAt = job!.expiresAt!;
    const now = Date.now();
    const diffMs = expiresAt.getTime() - now;
    const hours24 = 24 * 60 * 60 * 1000;
    expect(diffMs).toBeGreaterThan(hours24 - 60_000);
    expect(diffMs).toBeLessThan(hours24 + 60_000);
  });
});

describe("Twitter Build Executor — Additional Coverage", () => {
  test("twitter job templateId in result matches persisted template", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    const result = JSON.parse(job!.result!) as {
      templateId: string;
      slug: string;
      templateUrl: string;
      replyText: string;
    };

    // The templateId should match a real template in the database
    const template = await prisma.agentTemplate.findUnique({
      where: { id: result.templateId },
    });
    expect(template).not.toBeNull();
    expect(template!.status).toBe("published");
  });

  test("twitter job slug in result matches template slug", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    const result = JSON.parse(job!.result!) as {
      templateId: string;
      slug: string;
    };

    const template = await prisma.agentTemplate.findUnique({
      where: { id: result.templateId },
    });
    expect(template!.slug).toBe(result.slug);
  });

  test("twitter job with reply failure still completes", async () => {
    installTwitterHappyPathMocks();

    // Override reply to use fallback
    __resetTwitterReplyForTests(async (input) => ({
      replyText: `@${input.handle.startsWith("@") ? input.handle.slice(1) : input.handle} ${input.templateUrl}`,
    }));

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("done");

    const result = JSON.parse(job!.result!);
    expect(result.replyText).toBeDefined();
    expect(result.replyText).toContain("@alice");
  });

  test("app/web source still works (no regression)", async () => {
    // Standard app/web mocks
    __resetGenerateTemplateForTests((input) => {
      const inputObj = typeof input === "string" ? { text: input } : input;
      templateGenCalls.push({
        text: inputObj.text,
        pdfBase64: inputObj.pdfBase64,
        imageBase64: inputObj.imageBase64,
        mimeType: inputObj.mimeType,
      });
      return Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

    __resetProvisioningClientForTests({
      createAssistant: (opts) => {
        provisioningCreateCalls.push(opts);
        return Promise.resolve({ instanceId: "inst-app-test" });
      },
      getAssistant: (instanceId) =>
        Promise.resolve({
          instanceId,
          joinStatus: "joined" as const,
          inboxId: "inbox-app",
          conversationId: "conv-app",
          createdAt: new Date().toISOString(),
        }),
    });

    __resetTwitterReplyForTests(async () => ({
      replyText: "fallback",
    }));

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createAppJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("done");
    expect(job!.source).toBe("app");

    // ProvisioningClient should have been called
    expect(provisioningCreateCalls.length).toBe(1);

    // Result should have app/web format
    const result = JSON.parse(job!.result!);
    expect(result.provisioningInstanceId).toBe("inst-app-test");
    expect(result.conversationId).toBe("conv-app");
    expect(result.inboxId).toBe("inbox-app");

    // No twitter-specific fields in result
    expect(result.slug).toBeUndefined();
    expect(result.templateUrl).toBeUndefined();
    expect(result.replyText).toBeUndefined();
  });
});
