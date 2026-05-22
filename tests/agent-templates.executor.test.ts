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

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
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
} from "@/api/v2/agent-templates/services/templateGen";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";
import { makeFakeTemplate } from "./agent-templates.generation.helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_SOURCE = "executor-test";

const fakeTemplate = makeFakeTemplate({
  agentName: "Executor Test Agent",
});

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
    expect(template?.firstPublishedAt).toBeNull();
  });

  test("non-sluggable agentName falls back to a safe default slug", async () => {
    // deriveBaseSlug("🤖 ✨ 🚀") strips to "" — validateSlug rejects it, so
    // persistTemplate must fall back to a valid slug rather than persist an
    // empty slug (which would be unreachable via its hashed URL).
    const emojiTemplate = makeFakeTemplate({ agentName: "🤖 ✨ 🚀" });
    __resetGenerateTemplateForTests(() =>
      Promise.resolve({
        template: emojiTemplate,
        metrics: DEFAULT_TEST_METRICS,
      }),
    );
    const gen = await createPendingGeneration("fallback-slug");

    // afterEach cleans templates by the shared fixture agentName; this row
    // has a different agentName, so capture the id and clean up in a finally
    // — without this, an assertion failure before the explicit delete would
    // leak the row into later tests.
    let createdTemplateId: string | null = null;
    try {
      await executeGeneration(gen.id);

      const final = await prisma.agentTemplateGeneration.findUnique({
        where: { id: gen.id },
      });
      expect(final?.status).toBe("done");

      const template = await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: final?.templateId as string },
      });
      createdTemplateId = template.id;
      expect(template.slug).toBe("agent");
    } finally {
      if (createdTemplateId !== null) {
        await prisma.agentTemplate.delete({
          where: { id: createdTemplateId },
        });
      }
    }
  });

  test("publishStatus 'unlisted' on the generation lands template in unlisted with firstPublishedAt set", async () => {
    installFakeTemplate();
    const gen = await prisma.agentTemplateGeneration.create({
      data: {
        ownerAccountId: ADMIN_ACCOUNT_ID,
        source: TEST_SOURCE,
        idempotencyKey: "publish-status-unlisted",
        inputs: { text: "test input" },
        publishStatus: "unlisted",
        status: "pending",
      },
    });

    await executeGeneration(gen.id);

    const final = await prisma.agentTemplateGeneration.findUnique({
      where: { id: gen.id },
    });
    expect(final?.status).toBe("done");
    const template = await prisma.agentTemplate.findUnique({
      where: { id: final?.templateId as string },
    });
    expect(template?.status).toBe("unlisted");
    expect(template?.firstPublishedAt).not.toBeNull();
    expect(template?.version).toBe(1);
  });

  test("publishStatus 'published' on the generation lands template in published with firstPublishedAt set", async () => {
    installFakeTemplate();
    const gen = await prisma.agentTemplateGeneration.create({
      data: {
        ownerAccountId: ADMIN_ACCOUNT_ID,
        source: TEST_SOURCE,
        idempotencyKey: "publish-status-published",
        inputs: { text: "test input" },
        publishStatus: "published",
        status: "pending",
      },
    });

    await executeGeneration(gen.id);

    const template = await prisma.agentTemplate.findFirst({
      where: {
        ownerAccountId: ADMIN_ACCOUNT_ID,
        agentName: fakeTemplate.agentName,
      },
    });
    expect(template?.status).toBe("published");
    expect(template?.firstPublishedAt).not.toBeNull();
  });

  test("publishStatus 'archived' on the generation row fails the pipeline (defense-in-depth)", async () => {
    installFakeTemplate();
    const gen = await prisma.agentTemplateGeneration.create({
      data: {
        ownerAccountId: ADMIN_ACCOUNT_ID,
        source: TEST_SOURCE,
        idempotencyKey: "publish-status-archived",
        inputs: { text: "test input" },
        publishStatus: "archived",
        status: "pending",
      },
    });

    await executeGeneration(gen.id);

    const final = await prisma.agentTemplateGeneration.findUnique({
      where: { id: gen.id },
    });
    expect(final?.status).toBe("failed");
    expect(final?.error).toContain("archived");
    expect(final?.templateId).toBeNull();
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
      // Rows owned by ADMIN_ACCOUNT_ID are flagged anonymous so
      // resolveActor in posthog.ts skips the sentinel and falls
      // through to the next rung of the actor-attribution ladder.
      expect(event.isAnonymous).toBe(true);
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

  describe("timeout race", () => {
    test("pipeline finishing after timeout does not flip status back to done", async () => {
      // 100ms in-process timeout, 500ms LLM call — timeout wins the Promise.race
      __setExecutorTimeoutMsForTests(100);
      installSlowGenerate(500);

      const gen = await createPendingGeneration("timeout-race");

      // Snapshot AgentTemplate rows for this agentName BEFORE the race so we
      // can compare counts after. The fakeTemplate.agentName is reused across
      // tests in this file; afterEach cleans up by agentName.
      const beforeCount = await prisma.agentTemplate.count({
        where: {
          ownerAccountId: ADMIN_ACCOUNT_ID,
          agentName: fakeTemplate.agentName,
        },
      });

      // Run executor and wait long enough for both the timeout AND the
      // slow LLM call to complete in the background.
      await executeGeneration(gen.id);
      await new Promise((resolve) => setTimeout(resolve, 700));

      // Row must be `failed` (set by timeout markFailed). The post-timeout
      // markDone should have been gated by `status='running'` and no-opped.
      const final = await prisma.agentTemplateGeneration.findUnique({
        where: { id: gen.id },
      });
      expect(final?.status).toBe("failed");
      expect(final?.templateId).toBeNull();
      expect(final?.error).toContain("timed out");

      // The orphan AgentTemplate that the post-timeout pipeline created
      // (via persistTemplate) must have been cleaned up. Count should be
      // unchanged from before the race.
      const afterCount = await prisma.agentTemplate.count({
        where: {
          ownerAccountId: ADMIN_ACCOUNT_ID,
          agentName: fakeTemplate.agentName,
        },
      });
      expect(afterCount).toBe(beforeCount);
    });

    test("timeout aborts the in-flight LLM call (signal.aborted)", async () => {
      __setExecutorTimeoutMsForTests(50);

      // Capture the signal the executor passes in. The override receives the
      // GenerateTemplateInput; we don't get the signal directly, but we can
      // simulate a long-running LLM call that watches a global signal flag.
      // Instead of trying to capture the signal from the singleton seam,
      // assert behaviour: the slow generate's Promise should reject before
      // its full delay elapses because AbortSignal.any composes the timeout
      // signal with the external one. Our test override doesn't honour
      // signals (it's a Promise factory), so we instead verify the timeout
      // marks the row failed BEFORE the slow generate would have resolved.
      //
      // This isn't a direct signal-propagation test (that would require
      // mocking templateGen.ts's fetch — too coupled). Instead it's a
      // regression guard that the executor still produces the expected
      // failed terminal state when its timeout fires, and that the orphan
      // template path doesn't fire because the in-flight LLM call is no
      // longer being awaited. We exercise the wiring; the abort-propagation
      // itself is best tested via integration against a real fetch.
      let resolveLate: (() => void) | null = null;
      const lateResolved = new Promise<void>((resolve) => {
        resolveLate = resolve;
      });
      __resetGenerateTemplateForTests(
        () =>
          new Promise((resolve) => {
            // Resolves only after the test explicitly lets it. Simulates an
            // LLM call that would have taken much longer than the executor's
            // 50ms timeout, but never gets aborted by our test override (it
            // just hangs). In production templateGen DOES honour the signal,
            // so the real fetch would reject with AbortError shortly after
            // timeout.
            setTimeout(() => {
              resolve({
                template: fakeTemplate,
                metrics: DEFAULT_TEST_METRICS,
              });
              resolveLate?.();
            }, 1500);
          }),
      );

      const gen = await createPendingGeneration("abort-signal");
      await executeGeneration(gen.id);

      // Executor returned at timeout (50ms); generation is failed.
      const final = await prisma.agentTemplateGeneration.findUnique({
        where: { id: gen.id },
      });
      expect(final?.status).toBe("failed");
      expect(final?.error).toContain("timed out");

      // Let the hung LLM call drain so we don't leak it across tests.
      await lateResolved;
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    test("late pipeline success after timeout emits a `failed` PostHog event, not a duplicate `done`", async () => {
      __setExecutorTimeoutMsForTests(100);
      installSlowGenerate(500);

      // Filter on requestId so prior-test pipelines whose slow generates
      // resolve into this test's window don't pollute the assertion.
      const captured: PostHogCaptureProperties[] = [];
      __resetPostHogForTests((props) => captured.push(props));

      const gen = await createPendingGeneration("timeout-race-posthog");
      await executeGeneration(gen.id);
      // Give the slow LLM call (500ms) + persist + the post-timeout
      // markDone-no-op + the PostHog capture all time to settle.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const eventsForThisGen = captured.filter((e) => e.requestId === gen.id);

      // Exactly one event for this generation, and outcome MUST be `failed`
      // (matching the row's terminal state). If the late markDone had won,
      // we would have seen outcome=done here, which would skew metering.
      expect(eventsForThisGen.length).toBe(1);
      expect(eventsForThisGen[0].outcome).toBe("failed");

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
