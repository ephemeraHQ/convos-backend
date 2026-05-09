/**
 * PostHog metering tests for the create-job background executor.
 *
 * Covers VAL-CJ-PH-001..007:
 *   PH-001: Successful job generation emits builder.template.generated event
 *   PH-002: Event includes source: "create-job" property
 *   PH-003: Event includes the ownerAccountId
 *   PH-004: Event is not emitted for failed generations
 *   PH-005: Event includes input type property
 *   PH-006: Event uses the existing PostHog service at posthog.ts
 *   PH-007: Event is emitted exactly once per successful job
 */

/* eslint-disable @typescript-eslint/require-await */

import { readFileSync } from "node:fs";
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
import { ADMIN_ACCOUNT_ID } from "../src/utils/prefixed-id";
import { prisma } from "../src/utils/prisma";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a CreateJob row in pending state for testing. */
async function createTestJob(overrides?: {
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
      input: JSON.stringify(input),
      ownerAccountId: overrides?.ownerAccountId ?? ADMIN_ACCOUNT_ID,
    },
  });

  return job.id;
}

/** Standard mock template generation result. */
const MOCK_TEMPLATE: GeneratedTemplate = {
  agentName: "Math Tutor",
  description: "A helpful math tutor",
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
});

// ---------------------------------------------------------------------------
// Helper: install mock services that simulate happy path
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
      Promise.resolve({ instanceId: "inst-test-123" }),
    getAssistant: async (instanceId: string) => ({
      instanceId,
      joinStatus: "joined" as const,
      inboxId: "inbox-test-456",
      conversationId: "conv-test-789",
      createdAt: new Date().toISOString(),
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CreateJob PostHog Metering", () => {
  test("VAL-CJ-PH-001: successful job generation emits builder.template.generated event", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    expect(capturedPostHog.length).toBe(1);
  });

  test("VAL-CJ-PH-002: event includes source: create-job property", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].source).toBe("create-job");
  });

  test("VAL-CJ-PH-003: event includes the ownerAccountId", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  test("VAL-CJ-PH-004: event is not emitted for failed generations", async () => {
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

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    // No PostHog event should have been captured
    expect(capturedPostHog.length).toBe(0);
  });

  test("VAL-CJ-PH-005: event includes inputType property for text input", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob({
      input: {
        text: "A helpful math tutor",
        joinUrl: "xmtp:https://relay.example.com/join",
      },
    });
    await executeCreateJob(jobId);

    expect(capturedPostHog[0].inputType).toBe("text");
  });

  test("VAL-CJ-PH-005: event includes inputType property for pdfBase64 input", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob({
      input: {
        pdfBase64: "dGVzdA==",
        mimeType: "application/pdf",
        joinUrl: "xmtp:https://relay.example.com/join",
      },
    });
    await executeCreateJob(jobId);

    expect(capturedPostHog[0].inputType).toBe("pdfBase64");
  });

  test("VAL-CJ-PH-005: event includes inputType property for imageBase64 input", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob({
      input: {
        imageBase64: "iVBORw0KGgo=",
        mimeType: "image/png",
        joinUrl: "xmtp:https://relay.example.com/join",
      },
    });
    await executeCreateJob(jobId);

    expect(capturedPostHog[0].inputType).toBe("imageBase64");
  });

  test("VAL-CJ-PH-006: event uses the existing PostHog service at posthog.ts", () => {
    // Verify the job executor imports from the existing posthog.ts module
    const source = readFileSync(
      new URL(
        "../src/api/v2/agent-templates/services/job-executor.ts",
        import.meta.url,
      ),
      "utf8",
    );

    // Must import from the existing posthog service, not create a new client
    expect(source).toContain('from "./posthog"');
    expect(source).toContain("capturePostHog");
    // Must NOT import posthog-node directly
    expect(source).not.toContain("posthog-node");
  });

  test("VAL-CJ-PH-007: event is emitted exactly once per successful job", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    // Exactly one capture call, not zero or multiple
    expect(capturedPostHog.length).toBe(1);
  });

  test("event includes generation metrics (model, promptTokens, completionTokens, latencyMs)", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    const props = capturedPostHog[0];
    expect(typeof props.model).toBe("string");
    expect(typeof props.promptTokens).toBe("number");
    expect(typeof props.completionTokens).toBe("number");
    expect(typeof props.latencyMs).toBe("number");
  });

  test("PostHog fires even when provisioning later fails", async () => {
    // Template generation succeeds but provisioning fails
    // PostHog should fire for the generation success
    __resetGenerateTemplateForTests(() =>
      Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      }),
    );

    __resetProvisioningClientForTests({
      createAssistant: () => {
        throw new Error("Playground returned 500");
      },
      getAssistant: () => {
        throw new Error("Should not be called");
      },
    });

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    // PostHog should still have fired (generation succeeded)
    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].source).toBe("create-job");

    // Job should be failed (provisioning failed)
    const job = await prisma.createJob.findUnique({
      where: { id: jobId },
      select: { status: true, error: true },
    });
    expect(job!.status).toBe("failed");
  });

  test("event constant is builder.template.generated", () => {
    expect(BUILDER_TEMPLATE_GENERATED_EVENT).toBe("builder.template.generated");
  });
});
