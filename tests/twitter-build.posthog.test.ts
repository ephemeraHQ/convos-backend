/**
 * PostHog metering tests for twitter builds — cross-source source field verification.
 *
 * Covers VAL-TB-CROSS-006..007:
 *   CROSS-006: PostHog event fires with source="twitter" for twitter builds
 *   CROSS-007: PostHog event fires with source="create-job" for app/web builds (no regression)
 *
 * Additional coverage:
 *   - PostHog event includes ownerAccountId for twitter builds
 *   - PostHog event includes inputType="idea" for twitter builds
 *   - PostHog event is not emitted when twitter generation fails
 *   - PostHog event fires exactly once per twitter build
 *   - source="create-job" still used for app/web builds after twitter integration
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetPostHogForTests,
  BUILDER_TEMPLATE_GENERATED_EVENT,
  type PostHogCaptureProperties,
} from "../src/api/v2/agent-templates/services/posthog";
import {
  __resetProvisioningClientForTests,
  type CreateAssistantOpts,
} from "../src/api/v2/agent-templates/services/provisioningClient";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "../src/api/v2/agent-templates/services/templateGen";
import { __resetTwitterReplyForTests } from "../src/api/v2/agent-templates/services/twitterReply";
import { ADMIN_ACCOUNT_ID } from "../src/utils/prefixed-id";
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

/** Captured PostHog calls — reset beforeEach. */
let capturedPostHog: PostHogCaptureProperties[] = [];

const stubPostHog = () => {
  capturedPostHog = [];
  __resetPostHogForTests((properties) => {
    capturedPostHog.push(properties);
  });
};

beforeEach(() => {
  stubPostHog();
  __resetGenerateTemplateForTests(null);
  __resetProvisioningClientForTests(null);
  __resetTwitterReplyForTests(null);
});

afterEach(async () => {
  // Clean up test jobs and templates
  await prisma.createJob.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID },
  });
  await prisma.agentTemplate.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID },
  });
  __resetGenerateTemplateForTests(null);
  __resetProvisioningClientForTests(null);
  __resetPostHogForTests(null);
  __resetTwitterReplyForTests(null);
});

// ---------------------------------------------------------------------------
// Mock installation
// ---------------------------------------------------------------------------

function installTwitterHappyPathMocks(): void {
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: MOCK_TEMPLATE,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );

  __resetProvisioningClientForTests({
    createAssistant: (_opts: CreateAssistantOpts) =>
      Promise.resolve({ instanceId: "should-not-be-called" }),
    getAssistant: (instanceId: string) =>
      Promise.resolve({
        instanceId,
        joinStatus: "joined" as const,
        createdAt: new Date().toISOString(),
      }),
  });

  __resetTwitterReplyForTests((input) =>
    Promise.resolve({
      replyText: `@${input.handle.startsWith("@") ? input.handle.slice(1) : input.handle} Meet ${input.agentName} — ${input.firstSentence}. ${input.templateUrl}`,
    }),
  );
}

function installAppWebHappyPathMocks(): void {
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: MOCK_TEMPLATE,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );

  __resetProvisioningClientForTests({
    createAssistant: (_opts: CreateAssistantOpts) =>
      Promise.resolve({ instanceId: "inst-posthog-app" }),
    getAssistant: (instanceId: string) =>
      Promise.resolve({
        instanceId,
        joinStatus: "joined" as const,
        inboxId: "inbox-posthog",
        conversationId: "conv-posthog",
        createdAt: new Date().toISOString(),
      }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Twitter Build PostHog Metering", () => {
  // ── VAL-TB-CROSS-006: PostHog event fires with source="twitter" for twitter builds ──

  test("VAL-TB-CROSS-006: PostHog fires with source='twitter' for twitter builds", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].source).toBe("twitter");
  });

  test("PostHog event name is builder.template.generated for twitter builds", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    // Verify the event constant is correct
    expect(BUILDER_TEMPLATE_GENERATED_EVENT).toBe("builder.template.generated");
    expect(capturedPostHog.length).toBe(1);
  });

  test("PostHog event includes ownerAccountId for twitter builds", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    expect(capturedPostHog[0].ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  test("PostHog event includes inputType='idea' for twitter builds", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    expect(capturedPostHog[0].inputType).toBe("idea");
  });

  test("PostHog event is not emitted when twitter generation fails", async () => {
    // Template generation throws — no PostHog event should fire
    __resetGenerateTemplateForTests(() => {
      throw new Error("LLM API error: model unavailable");
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

    __resetTwitterReplyForTests(() =>
      Promise.resolve({
        replyText: "@alice fallback",
      }),
    );

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    // No PostHog event should have been captured
    expect(capturedPostHog.length).toBe(0);
  });

  test("PostHog event fires exactly once per successful twitter build", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    // Exactly one capture call, not zero or multiple
    expect(capturedPostHog.length).toBe(1);
  });

  test("PostHog event includes generation metrics for twitter builds", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTwitterJob();
    await executeCreateJob(jobId);

    const props = capturedPostHog[0];
    expect(typeof props.model).toBe("string");
    expect(typeof props.promptTokens).toBe("number");
    expect(typeof props.completionTokens).toBe("number");
    expect(typeof props.latencyMs).toBe("number");
  });

  // ── VAL-TB-CROSS-007: PostHog event fires with source="create-job" for app/web builds ──

  test("VAL-TB-CROSS-007: PostHog fires with source='create-job' for app source builds", async () => {
    installAppWebHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createAppJob();
    await executeCreateJob(jobId);

    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].source).toBe("create-job");
  });

  test("PostHog fires with source='create-job' for web source builds", async () => {
    installAppWebHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createWebJob();
    await executeCreateJob(jobId);

    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].source).toBe("create-job");
  });

  test("PostHog event includes inputType='text' for app builds", async () => {
    installAppWebHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createAppJob();
    await executeCreateJob(jobId);

    expect(capturedPostHog[0].inputType).toBe("text");
  });

  test("PostHog event includes ownerAccountId for app builds", async () => {
    installAppWebHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createAppJob();
    await executeCreateJob(jobId);

    expect(capturedPostHog[0].ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  test("PostHog event is not emitted when app/web generation fails", async () => {
    __resetGenerateTemplateForTests(() => {
      throw new Error("Generation failed");
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

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createAppJob();
    await executeCreateJob(jobId);

    expect(capturedPostHog.length).toBe(0);
  });

  test("app source PostHog fires even when provisioning later fails", async () => {
    // Template generation succeeds but provisioning fails
    __resetGenerateTemplateForTests(() =>
      Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      }),
    );

    __resetProvisioningClientForTests({
      createAssistant: () => {
        throw new Error("Provisioning returned 500");
      },
      getAssistant: () => {
        throw new Error("Should not be called");
      },
    });

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createAppJob();
    await executeCreateJob(jobId);

    // PostHog should still have fired (generation succeeded)
    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].source).toBe("create-job");
  });

  // ── Cross-source PostHog comparison ──

  test("twitter and app builds emit different source values in the same test run", async () => {
    installTwitterHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    // Execute a twitter build
    const twitterJobId = await createTwitterJob();
    await executeCreateJob(twitterJobId);

    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].source).toBe("twitter");

    // Reset PostHog captures
    capturedPostHog = [];

    // Now execute an app build with app mocks
    installAppWebHappyPathMocks();
    const { executeCreateJob: executeCreateJob2 } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const appJobId = await createAppJob();
    await executeCreateJob2(appJobId);

    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].source).toBe("create-job");
  });

  test("concurrent twitter + app builds emit correct sources independently", async () => {
    // Unified mock
    __resetGenerateTemplateForTests(() =>
      Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      }),
    );

    __resetProvisioningClientForTests({
      createAssistant: (_opts: CreateAssistantOpts) =>
        Promise.resolve({ instanceId: "inst-ph-concurrent" }),
      getAssistant: (instanceId: string) =>
        Promise.resolve({
          instanceId,
          joinStatus: "joined" as const,
          inboxId: "inbox-ph",
          conversationId: "conv-ph",
          createdAt: new Date().toISOString(),
        }),
    });

    __resetTwitterReplyForTests((input) =>
      Promise.resolve({
        replyText: `@${input.handle} ${input.templateUrl}`,
      }),
    );

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    // Create both jobs and execute concurrently
    const twitterJobId = await createTwitterJob();
    const appJobId = await createAppJob();

    await Promise.all([
      executeCreateJob(twitterJobId),
      executeCreateJob(appJobId),
    ]);

    // Should have exactly 2 PostHog events
    expect(capturedPostHog.length).toBe(2);

    // One should have source="twitter", one source="create-job"
    const sources = capturedPostHog.map((p) => p.source).sort();
    expect(sources).toEqual(["create-job", "twitter"]);
  });
});
