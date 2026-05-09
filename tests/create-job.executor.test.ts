/**
 * Background job executor tests.
 *
 * Validates VAL-CJ-BG-001 through VAL-CJ-BG-018:
 *   - BG-001: Job transitions from pending to generating
 *   - BG-002: Job calls templateGen service during generating phase
 *   - BG-003: Job transitions from generating to provisioning after template generation
 *   - BG-004: Job persists generated template as draft AgentTemplate
 *   - BG-005: Job calls POST /api/assistants during provisioning phase
 *   - BG-006: Job polls GET /api/assistants/:instanceId until terminal state
 *   - BG-007: Job transitions to done when joinStatus is "joined"
 *   - BG-008: Job transitions to failed when joinStatus is "failed"
 *   - BG-009: Job transitions to failed when templateGen throws
 *   - BG-010: Job transitions to failed when ProvisioningClient POST throws
 *   - BG-011: Job transitions to failed when provisioning service is unreachable
 *   - BG-012: 5-minute timeout
 *   - BG-013: Job sets expiresAt when reaching terminal state
 *   - BG-014: Concurrent jobs execute independently
 *   - BG-015: Job follows strict state machine order
 *   - BG-016: Job can transition from any non-terminal state to failed
 *   - BG-017: Generated template uses ADMIN_ACCOUNT_ID as owner
 *   - BG-018: Background job uses the joinUrl from the original request
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
import { ADMIN_ACCOUNT_ID } from "../src/utils/constants";
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

/** Get a job's current status from the database. */
async function getJobStatus(jobId: string) {
  return prisma.createJob.findUnique({
    where: { id: jobId },
    select: {
      status: true,
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

// Track templateGen calls for assertion
let templateGenCalls: GenerateTemplateInput_Record[] = [];

interface GenerateTemplateInput_Record {
  text?: string;
  pdfBase64?: string;
  imageBase64?: string;
  mimeType?: string;
}

// Track provisioning create calls for assertion
let provisioningCreateCalls: CreateAssistantOpts[] = [];

beforeEach(() => {
  // Reset tracking
  templateGenCalls = [];
  provisioningCreateCalls = [];

  // Reset test seams — use no-op defaults
  __resetGenerateTemplateForTests(null);
  __resetProvisioningClientForTests(null);
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
});

// ---------------------------------------------------------------------------
// Helper: install mock services that simulate happy path
// ---------------------------------------------------------------------------

function installHappyPathMocks(opts?: {
  joinDelay?: number;
  intermediatePolls?: number;
}): void {
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

  // Mutable counter for intermediate polls
  let remainingIntermediate = opts?.intermediatePolls ?? 0;

  // Mock ProvisioningClient — no intermediate polls by default for faster tests
  __resetProvisioningClientForTests({
    createAssistant: (opts_create) => {
      provisioningCreateCalls.push(opts_create);
      return Promise.resolve({ instanceId: "inst-test-123" });
    },
    getAssistant: async (instanceId: string) => {
      // Simulate intermediate states before terminal
      if (remainingIntermediate > 0) {
        remainingIntermediate--;
        return {
          instanceId,
          joinStatus: "starting" as const,
          createdAt: new Date().toISOString(),
        };
      }
      // Delay if requested
      if (opts?.joinDelay) {
        await new Promise((r) => setTimeout(r, opts.joinDelay));
      }
      return {
        instanceId,
        joinStatus: "joined" as const,
        inboxId: "inbox-test-456",
        conversationId: "conv-test-789",
        createdAt: new Date().toISOString(),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CreateJob Executor — Happy Path", () => {
  // Dynamically import executor so it picks up the test seam resets
  // We need to re-import for each test because the executor reads
  // the service overrides at call time (via the test seams).

  test("VAL-CJ-BG-001: job transitions from pending to generating", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    // At minimum, the job should have transitioned through generating
    const job = await getJobStatus(jobId);
    // It should be done (went through all states)
    expect(job!.status).toBe("done");
  });

  test("VAL-CJ-BG-002: job calls templateGen with correct input", async () => {
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

    expect(templateGenCalls.length).toBeGreaterThanOrEqual(1);
    expect(templateGenCalls[0].text).toBe("A helpful math tutor");
  });

  test("VAL-CJ-BG-002: templateGen receives pdfBase64 input", async () => {
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

    expect(templateGenCalls.length).toBe(1);
    expect(templateGenCalls[0].pdfBase64).toBe("dGVzdA==");
    expect(templateGenCalls[0].mimeType).toBe("application/pdf");
  });

  test("VAL-CJ-BG-003: job transitions from generating to provisioning", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    // The job should have gone through generating → provisioning → done
    // We verify this by checking the final state and that both services were called
    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("done");

    // templateGen was called (proves generating phase ran)
    expect(templateGenCalls.length).toBe(1);

    // ProvisioningClient.createAssistant was called (proves provisioning phase ran)
    expect(provisioningCreateCalls.length).toBe(1);

    // Result has templateId (set during generating → provisioning transition)
    const result = JSON.parse(job!.result!);
    expect(result.templateId).toBeDefined();

    // Result has provisioningInstanceId (set during provisioning → done transition)
    expect(result.provisioningInstanceId).toBe("inst-test-123");
  });

  test("VAL-CJ-BG-004: job persists generated template as draft AgentTemplate", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    // Find the template created by the executor
    const templates = await prisma.agentTemplate.findMany({
      where: { ownerAccountId: ADMIN_ACCOUNT_ID },
    });

    expect(templates.length).toBeGreaterThanOrEqual(1);
    const template = templates[0];
    expect(template.agentName).toBe("Math Tutor");
    expect(template.prompt).toContain("helpful math tutor");
    expect(template.status).toBe("draft");
  });

  test("VAL-CJ-BG-005: job calls POST /api/assistants with correct payload", async () => {
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

    expect(provisioningCreateCalls.length).toBe(1);
    const call = provisioningCreateCalls[0];
    expect(call.name).toBe("Math Tutor");
    expect(call.instructions).toContain("helpful math tutor");
    expect(call.joinUrl).toBe("xmtp:https://relay.example.com/join");
  });

  test("VAL-CJ-BG-006: job polls getAssistant until terminal joinStatus", async () => {
    let pollCount = 0;

    __resetGenerateTemplateForTests((input) => {
      templateGenCalls.push(
        typeof input === "string"
          ? { text: input }
          : (input as GenerateTemplateInput_Record),
      );
      return Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

    __resetProvisioningClientForTests({
      createAssistant: (opts) => {
        provisioningCreateCalls.push(opts);
        return Promise.resolve({ instanceId: "inst-poll-test" });
      },
      getAssistant: async (instanceId) => {
        pollCount++;
        // First 3 polls: starting, then pending_acceptance, then joined
        if (pollCount <= 2) {
          return {
            instanceId,
            joinStatus: "starting" as const,
            createdAt: new Date().toISOString(),
          };
        }
        if (pollCount === 3) {
          return {
            instanceId,
            joinStatus: "pending_acceptance" as const,
            createdAt: new Date().toISOString(),
          };
        }
        return {
          instanceId,
          joinStatus: "joined" as const,
          inboxId: "inbox-joined",
          conversationId: "conv-joined",
          createdAt: new Date().toISOString(),
        };
      },
    });

    const { executeCreateJob, __setPollIntervalMsForTests } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    // Use a short poll interval for testing
    __setPollIntervalMsForTests(50);

    try {
      const jobId = await createTestJob();
      await executeCreateJob(jobId);

      // Should have polled at least 4 times (2 starting + 1 pending_acceptance + 1 joined)
      expect(pollCount).toBeGreaterThanOrEqual(4);

      const job = await getJobStatus(jobId);
      expect(job!.status).toBe("done");
    } finally {
      __setPollIntervalMsForTests(null);
    }
  });

  test("VAL-CJ-BG-007: job transitions to done when joinStatus is joined", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("done");

    // Result should contain template and instance details
    const result = JSON.parse(job!.result!);
    expect(result.templateId).toBeDefined();
    expect(result.provisioningInstanceId).toBe("inst-test-123");
    expect(result.conversationId).toBe("conv-test-789");
    expect(result.inboxId).toBe("inbox-test-456");
  });

  test("VAL-CJ-BG-008: job transitions to failed when joinStatus is failed", async () => {
    __resetGenerateTemplateForTests((input) => {
      templateGenCalls.push(
        typeof input === "string"
          ? { text: input }
          : (input as GenerateTemplateInput_Record),
      );
      return Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

    __resetProvisioningClientForTests({
      createAssistant: (opts) => {
        provisioningCreateCalls.push(opts);
        return Promise.resolve({ instanceId: "inst-fail-test" });
      },
      getAssistant: async (instanceId) => ({
        instanceId,
        joinStatus: "failed" as const,
        joinFailureReason: "Timeout waiting for acceptance",
        inboxId: null,
        conversationId: null,
        createdAt: new Date().toISOString(),
      }),
    });

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("Timeout waiting for acceptance");
  });

  test("VAL-CJ-BG-009: job transitions to failed when templateGen throws", async () => {
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

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("LLM API error");
  });

  test("VAL-CJ-BG-010: job transitions to failed when ProvisioningClient POST throws", async () => {
    __resetGenerateTemplateForTests((input) => {
      templateGenCalls.push(
        typeof input === "string"
          ? { text: input }
          : (input as GenerateTemplateInput_Record),
      );
      return Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

    __resetProvisioningClientForTests({
      createAssistant: () => {
        throw new Error(
          "ProvisioningClient: POST /api/assistants returned 500 — Internal Server Error",
        );
      },
      getAssistant: (instanceId) =>
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

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("500");
  });

  test("VAL-CJ-BG-011: job transitions to failed when provisioning service is unreachable", async () => {
    __resetGenerateTemplateForTests((input) => {
      templateGenCalls.push(
        typeof input === "string"
          ? { text: input }
          : (input as GenerateTemplateInput_Record),
      );
      return Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

    __resetProvisioningClientForTests({
      createAssistant: () => {
        throw new Error(
          "ProvisioningClient: network error calling POST /api/assistants — fetch failed",
        );
      },
      getAssistant: () => {
        throw new Error("ProvisioningClient: network error — fetch failed");
      },
    });

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("failed");
    expect(job!.error).toMatch(/network|connect|unreachable|fetch failed/i);
  });

  test("VAL-CJ-BG-012: 5-minute timeout causes failed state", async () => {
    // This test uses a short timeout override instead of actually waiting 5 minutes
    __resetGenerateTemplateForTests((input) => {
      templateGenCalls.push(
        typeof input === "string"
          ? { text: input }
          : (input as GenerateTemplateInput_Record),
      );
      return Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

    // Provisioning service never returns terminal state
    __resetProvisioningClientForTests({
      createAssistant: (opts) => {
        provisioningCreateCalls.push(opts);
        return Promise.resolve({ instanceId: "inst-timeout-test" });
      },
      getAssistant: async (instanceId) => {
        // Always return starting — never terminal
        return {
          instanceId,
          joinStatus: "starting" as const,
          createdAt: new Date().toISOString(),
        };
      },
    });

    const {
      executeCreateJob,
      __setTimeoutMsForTests,
      __setPollIntervalMsForTests,
    } = await import("../src/api/v2/agent-templates/services/job-executor");

    // Set a very short timeout for testing (200ms) and a short poll interval
    __setTimeoutMsForTests(200);
    __setPollIntervalMsForTests(50);

    try {
      const jobId = await createTestJob();
      await executeCreateJob(jobId);

      const job = await getJobStatus(jobId);
      expect(job!.status).toBe("failed");
      expect(job!.error).toMatch(/timeout|took too long/i);
    } finally {
      __setTimeoutMsForTests(null);
      __setPollIntervalMsForTests(null);
    }
  });

  test("VAL-CJ-BG-013: job sets expiresAt when reaching terminal state (done)", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
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

  test("VAL-CJ-BG-013: job sets expiresAt when reaching terminal state (failed)", async () => {
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

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
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

  test("VAL-CJ-BG-014: concurrent jobs execute independently", async () => {
    // Track which job is being processed
    __resetGenerateTemplateForTests((input) => {
      const inputObj = typeof input === "string" ? { text: input } : input;
      templateGenCalls.push({
        text: inputObj.text,
        pdfBase64: inputObj.pdfBase64,
        imageBase64: inputObj.imageBase64,
        mimeType: inputObj.mimeType,
      });
      // Fail if the input text is "Job B - fail"
      if (inputObj.text === "Job B - fail") {
        throw new Error("Generation failed for Job B");
      }
      return Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

    __resetProvisioningClientForTests({
      createAssistant: (opts) => {
        provisioningCreateCalls.push(opts);
        return Promise.resolve({ instanceId: "inst-concurrent" });
      },
      getAssistant: async (instanceId) => ({
        instanceId,
        joinStatus: "joined" as const,
        inboxId: "inbox-concurrent",
        conversationId: "conv-concurrent",
        createdAt: new Date().toISOString(),
      }),
    });

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobIdA = await createTestJob({
      input: {
        text: "Job A - succeed",
        joinUrl: "xmtp:https://relay.example.com/join-a",
      },
    });
    const jobIdB = await createTestJob({
      input: {
        text: "Job B - fail",
        joinUrl: "xmtp:https://relay.example.com/join-b",
      },
    });

    // Execute concurrently
    const [resultA, resultB] = await Promise.allSettled([
      executeCreateJob(jobIdA),
      executeCreateJob(jobIdB),
    ]);

    // Both should settle (not throw)
    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");

    // Job A should be done
    const jobA = await getJobStatus(jobIdA);
    expect(jobA!.status).toBe("done");

    // Job B should be failed (generation failed)
    const jobB = await getJobStatus(jobIdB);
    expect(jobB!.status).toBe("failed");
    expect(jobB!.error).toContain("Generation failed for Job B");
  });

  test("VAL-CJ-BG-015: job follows strict state machine order", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    // Verify all phases ran in order by checking services were called
    // and the final result has data from both the generating and provisioning phases
    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("done");

    // templateGen was called (generating phase)
    expect(templateGenCalls.length).toBe(1);

    // ProvisioningClient.createAssistant was called (provisioning phase)
    expect(provisioningCreateCalls.length).toBe(1);

    // Result contains data from both phases:
    // - templateId from generating → provisioning transition
    // - provisioningInstanceId, conversationId, inboxId from provisioning → done
    const result = JSON.parse(job!.result!);
    expect(result.templateId).toMatch(/^[0-9a-f]{8}-/);
    expect(result.provisioningInstanceId).toBe("inst-test-123");
    expect(result.conversationId).toBe("conv-test-789");
    expect(result.inboxId).toBe("inbox-test-456");
  });

  test("VAL-CJ-BG-016: job can transition from generating to failed (templateGen error)", async () => {
    __resetGenerateTemplateForTests(() => {
      throw new Error("Template generation error");
    });

    __resetProvisioningClientForTests({
      createAssistant: () => {
        throw new Error("Should not be called");
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

    // Job should have gone through generating before failing
    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("Template generation error");

    // ProvisioningClient.createAssistant was NOT called (provisioning never started)
    expect(provisioningCreateCalls.length).toBe(0);
  });

  test("VAL-CJ-BG-016: job can transition from provisioning to failed (provisioning POST error)", async () => {
    __resetGenerateTemplateForTests((input) => {
      templateGenCalls.push(
        typeof input === "string"
          ? { text: input }
          : (input as GenerateTemplateInput_Record),
      );
      return Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

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

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    // Job should have gone through generating and provisioning before failing
    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("Provisioning returned 500");

    // templateGen was called (generating phase ran)
    expect(templateGenCalls.length).toBe(1);

    // Template was persisted before provisioning failed
    const templates = await prisma.agentTemplate.findMany({
      where: { ownerAccountId: ADMIN_ACCOUNT_ID },
    });
    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(templates[0].status).toBe("draft");
  });

  test("VAL-CJ-BG-017: generated template uses ADMIN_ACCOUNT_ID as owner", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    const templates = await prisma.agentTemplate.findMany({
      where: { ownerAccountId: ADMIN_ACCOUNT_ID },
    });

    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(templates[0].ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  test("VAL-CJ-BG-018: background job uses the joinUrl from the original request", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const customJoinUrl = "xmtp:https://custom-relay.example.com/join";
    const jobId = await createTestJob({
      input: {
        text: "A helpful tutor",
        joinUrl: customJoinUrl,
      },
    });

    await executeCreateJob(jobId);

    // Verify the provisioning service was called with the correct joinUrl
    expect(provisioningCreateCalls.length).toBe(1);
    expect(provisioningCreateCalls[0].joinUrl).toBe(customJoinUrl);
  });
});

describe("CreateJob Executor — Edge Cases", () => {
  test("job already in terminal state is not re-executed", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    // Create a job already in done state
    const job = await prisma.createJob.create({
      data: {
        status: "done",
        input: JSON.stringify({ text: "test", joinUrl: "https://example.com" }),
        ownerAccountId: ADMIN_ACCOUNT_ID,
        result: JSON.stringify({
          templateId: "00000000-0000-4000-8000-000000000099",
        }),
      },
    });

    await executeCreateJob(job.id);

    // Should not have called templateGen (no new calls)
    expect(templateGenCalls.length).toBe(0);
  });

  test("job with nonexistent ID does nothing", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    // Should not throw
    await executeCreateJob("00000000-0000-0000-0000-000000000000");

    // No templateGen calls
    expect(templateGenCalls.length).toBe(0);
  });

  test("result includes templateId after persistence", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("done");

    const result = JSON.parse(job!.result!);
    expect(result.templateId).toBeDefined();
    expect(result.templateId).toMatch(/^[0-9a-f]{8}-/);

    // Verify the template actually exists
    const template = await prisma.agentTemplate.findUnique({
      where: { id: result.templateId },
    });
    expect(template).not.toBeNull();
  });

  test("conversationId and inboxId stored on job when joinStatus=joined", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    const result = JSON.parse(job!.result!);

    expect(result.conversationId).toBe("conv-test-789");
    expect(result.inboxId).toBe("inbox-test-456");
    expect(result.provisioningInstanceId).toBe("inst-test-123");
  });

  test("error includes joinFailureReason when joinStatus=failed", async () => {
    __resetGenerateTemplateForTests((input) => {
      templateGenCalls.push(
        typeof input === "string"
          ? { text: input }
          : (input as GenerateTemplateInput_Record),
      );
      return Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

    __resetProvisioningClientForTests({
      createAssistant: (opts) => {
        provisioningCreateCalls.push(opts);
        return Promise.resolve({ instanceId: "inst-fail-reason" });
      },
      getAssistant: async (instanceId) => ({
        instanceId,
        joinStatus: "failed" as const,
        joinFailureReason: "Agent rejected the group invite",
        inboxId: null,
        conversationId: null,
        createdAt: new Date().toISOString(),
      }),
    });

    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("Agent rejected the group invite");
  });

  test("template persists even when provisioning fails", async () => {
    __resetGenerateTemplateForTests((input) => {
      templateGenCalls.push(
        typeof input === "string"
          ? { text: input }
          : (input as GenerateTemplateInput_Record),
      );
      return Promise.resolve({
        template: MOCK_TEMPLATE,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

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

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    // Job should be failed
    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("failed");

    // Template should still exist as draft
    const templates = await prisma.agentTemplate.findMany({
      where: { ownerAccountId: ADMIN_ACCOUNT_ID },
    });

    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(templates[0].status).toBe("draft");
  });

  test("provisioning receives metadata with source=create-job", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    const jobId = await createTestJob();
    await executeCreateJob(jobId);

    expect(provisioningCreateCalls.length).toBe(1);
    expect(provisioningCreateCalls[0].metadata).toMatchObject({
      source: "create-job",
    });
  });

  test("job with imageBase64 input sends correct input to templateGen", async () => {
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

    expect(templateGenCalls.length).toBe(1);
    expect(templateGenCalls[0].imageBase64).toBe("iVBORw0KGgo=");
    expect(templateGenCalls[0].mimeType).toBe("image/png");
  });

  test("descriptive error stored when templateGen fails", async () => {
    __resetGenerateTemplateForTests(() => {
      throw new Error("OpenRouter API error 429: Rate limit exceeded");
    });

    __resetProvisioningClientForTests({
      createAssistant: () => {
        throw new Error("Should not be called");
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

    const job = await getJobStatus(jobId);
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("OpenRouter API error");
    expect(job!.error).toContain("429");
  });

  test("template ownerAccountId matches job.ownerAccountId, not hardcoded ADMIN_ACCOUNT_ID", async () => {
    installHappyPathMocks();
    const { executeCreateJob } = await import(
      "../src/api/v2/agent-templates/services/job-executor"
    );

    // Create a custom account and job with a non-admin ownerAccountId
    const customOwner = await prisma.account.create({ data: {} });
    try {
      const jobId = await createTestJob({
        ownerAccountId: customOwner.id,
      });
      await executeCreateJob(jobId);

      // The persisted template should use the job's ownerAccountId,
      // not the hardcoded ADMIN_ACCOUNT_ID
      const templates = await prisma.agentTemplate.findMany({
        where: { ownerAccountId: customOwner.id },
      });

      expect(templates.length).toBeGreaterThanOrEqual(1);
      expect(templates[0].ownerAccountId).toBe(customOwner.id);

      // Verify it's NOT the admin account
      expect(templates[0].ownerAccountId).not.toBe(ADMIN_ACCOUNT_ID);
    } finally {
      // Always clean up the custom account row even if assertions above failed
      await prisma.agentTemplate.deleteMany({
        where: { ownerAccountId: customOwner.id },
      });
      await prisma.createJob.deleteMany({
        where: { ownerAccountId: customOwner.id },
      });
      await prisma.account.delete({ where: { id: customOwner.id } });
    }
  });
});
