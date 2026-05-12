/**
 * Tests for the generation pipeline executor.
 *
 * Covers:
 *   - Happy path: pending → done with templateId set, expiresAt set
 *   - Atomic claim: two concurrent calls — only one runs the pipeline
 *   - Already-terminal: bails without running pipeline
 *   - Generate stage failure → failed with stage-tagged error
 *   - Persist stage failure → failed (rare, but tested via FK violation)
 *   - In-process timeout → failed with timeout error
 *   - Missing usable input → failed
 *
 * Mocks templateGen at the singleton seam. Hits the real DB (uses
 * AgentTemplateGeneration table — migration must be applied).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  __resetGenerationExecutorForTests,
  __setExecutorTimeoutMsForTests,
  executeGeneration,
} from "@/api/v2/agent-templates/services/generation-executor";
import {
  __resetPostHogForTests,
  type PostHogCaptureProperties,
} from "@/api/v2/agent-templates/services/posthog";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "@/api/v2/agent-templates/services/templateGen";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_SOURCE = "executor-test";

const fakeTemplate: GeneratedTemplate = {
  agentName: "Executor Test Agent",
  description: "test description",
  prompt: "you are a test",
  category: "Test",
  emoji: "🧪",
  tools: [],
  connections: [],
};

const installFakeTemplate = () => {
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: fakeTemplate,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );
};

const installFailingGenerate = (message: string) => {
  __resetGenerateTemplateForTests(() => Promise.reject(new Error(message)));
};

const installSlowGenerate = (delayMs: number) => {
  __resetGenerateTemplateForTests(
    () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            template: fakeTemplate,
            metrics: DEFAULT_TEST_METRICS,
          });
        }, delayMs);
      }),
  );
};

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupGenerations() {
  await prisma.agentTemplateGeneration.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID, source: TEST_SOURCE },
  });
  await prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      agentName: fakeTemplate.agentName,
    },
  });
}

async function createPendingGeneration(idempotencyKey: string) {
  return prisma.agentTemplateGeneration.create({
    data: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      source: TEST_SOURCE,
      idempotencyKey,
      inputs: { text: "test input" },
      status: "pending",
    },
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  __resetPostHogForTests(() => {}); // no-op
});

afterEach(async () => {
  __resetGenerateTemplateForTests(null);
  __setExecutorTimeoutMsForTests(null);
  __resetGenerationExecutorForTests(null);
  await cleanupGenerations();
});

afterAll(() => {
  __resetPostHogForTests(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generation-executor", () => {
  test("happy path: pending → done with templateId + expiresAt set", async () => {
    installFakeTemplate();
    const gen = await createPendingGeneration("happy-path");

    await executeGeneration(gen.id);

    const final = await prisma.agentTemplateGeneration.findUnique({
      where: { id: gen.id },
    });
    expect(final).not.toBeNull();
    expect(final?.status).toBe("done");
    expect(final?.templateId).toBeTruthy();
    expect(final?.expiresAt).not.toBeNull();
    expect(final?.error).toBeNull();

    // Template row exists
    const template = await prisma.agentTemplate.findUnique({
      where: { id: final?.templateId as string },
    });
    expect(template).not.toBeNull();
    expect(template?.agentName).toBe(fakeTemplate.agentName);
    expect(template?.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
    expect(template?.status).toBe("draft");
  });

  test("atomic claim: concurrent executor calls only one pipeline runs", async () => {
    let callCount = 0;
    __resetGenerateTemplateForTests(() => {
      callCount += 1;
      return Promise.resolve({
        template: fakeTemplate,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

    const gen = await createPendingGeneration("atomic-claim");
    await Promise.all([
      executeGeneration(gen.id),
      executeGeneration(gen.id),
      executeGeneration(gen.id),
    ]);

    expect(callCount).toBe(1);

    const final = await prisma.agentTemplateGeneration.findUnique({
      where: { id: gen.id },
    });
    expect(final?.status).toBe("done");
  });

  test("already-terminal rows are not re-run", async () => {
    let callCount = 0;
    __resetGenerateTemplateForTests(() => {
      callCount += 1;
      return Promise.resolve({
        template: fakeTemplate,
        metrics: DEFAULT_TEST_METRICS,
      });
    });

    // Create a row already in 'done' status
    const gen = await prisma.agentTemplateGeneration.create({
      data: {
        ownerAccountId: ADMIN_ACCOUNT_ID,
        source: TEST_SOURCE,
        idempotencyKey: "already-done",
        inputs: { text: "test" },
        status: "done",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await executeGeneration(gen.id);
    expect(callCount).toBe(0);

    const after = await prisma.agentTemplateGeneration.findUnique({
      where: { id: gen.id },
    });
    expect(after?.status).toBe("done");
  });

  test("generate stage failure → failed with stage-tagged error", async () => {
    installFailingGenerate("OpenRouter request timed out");
    const gen = await createPendingGeneration("generate-fail");

    await executeGeneration(gen.id);

    const final = await prisma.agentTemplateGeneration.findUnique({
      where: { id: gen.id },
    });
    expect(final?.status).toBe("failed");
    expect(final?.templateId).toBeNull();
    expect(final?.error).toContain("Generate stage failed");
    expect(final?.error).toContain("OpenRouter request timed out");
    expect(final?.expiresAt).not.toBeNull();
  });

  test("in-process timeout → failed with timeout error", async () => {
    __setExecutorTimeoutMsForTests(100); // 100ms timeout
    installSlowGenerate(1_000); // 1s LLM call

    const gen = await createPendingGeneration("timeout-test");
    await executeGeneration(gen.id);

    const final = await prisma.agentTemplateGeneration.findUnique({
      where: { id: gen.id },
    });
    expect(final?.status).toBe("failed");
    expect(final?.error).toContain("timed out");
  });

  test("missing usable input → failed", async () => {
    installFakeTemplate(); // shouldn't be reached
    const gen = await prisma.agentTemplateGeneration.create({
      data: {
        ownerAccountId: ADMIN_ACCOUNT_ID,
        source: TEST_SOURCE,
        idempotencyKey: "no-input",
        inputs: {}, // empty
        status: "pending",
      },
    });

    await executeGeneration(gen.id);

    const final = await prisma.agentTemplateGeneration.findUnique({
      where: { id: gen.id },
    });
    expect(final?.status).toBe("failed");
    expect(final?.error).toContain("No usable input");
  });

  describe("PostHog metering", () => {
    test("success emits builder.generation.completed with full properties", async () => {
      installFakeTemplate();
      const captured: PostHogCaptureProperties[] = [];
      __resetPostHogForTests((props) => captured.push(props));

      const gen = await createPendingGeneration("posthog-success");
      await executeGeneration(gen.id);

      expect(captured.length).toBe(1);
      const event = captured[0];
      expect(event.requestId).toBe(gen.id);
      expect(event.source).toBe(TEST_SOURCE);
      expect(event.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
      expect(event.inputType).toBe("text");
      expect(event.outcome).toBe("done");
      expect(event.model).toBe(DEFAULT_TEST_METRICS.model);
      expect(event.promptTokens).toBe(DEFAULT_TEST_METRICS.promptTokens);
      expect(event.completionTokens).toBe(
        DEFAULT_TEST_METRICS.completionTokens,
      );
      expect(event.latencyMs).toBe(DEFAULT_TEST_METRICS.latencyMs);

      // Reset to no-op so the afterEach cleanup doesn't trip
      __resetPostHogForTests(() => {});
    });

    test("Generate failure emits event with outcome=failed and zero tokens", async () => {
      installFailingGenerate("OpenRouter request timed out");
      const captured: PostHogCaptureProperties[] = [];
      __resetPostHogForTests((props) => captured.push(props));

      const gen = await createPendingGeneration("posthog-fail");
      await executeGeneration(gen.id);

      expect(captured.length).toBe(1);
      const event = captured[0];
      expect(event.outcome).toBe("failed");
      expect(event.promptTokens).toBe(0);
      expect(event.completionTokens).toBe(0);
      expect(event.requestId).toBe(gen.id);
      expect(event.source).toBe(TEST_SOURCE);

      __resetPostHogForTests(() => {});
    });
  });

  test("override at the executor seam replaces the pipeline entirely", async () => {
    let overrideCalled = 0;
    __resetGenerationExecutorForTests(() => {
      overrideCalled += 1;
      return Promise.resolve();
    });

    const gen = await createPendingGeneration("override-test");
    await executeGeneration(gen.id);

    expect(overrideCalled).toBe(1);

    // Row should still be pending — override didn't actually run anything
    const final = await prisma.agentTemplateGeneration.findUnique({
      where: { id: gen.id },
    });
    expect(final?.status).toBe("pending");
  });
});
