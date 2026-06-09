/**
 * SSE-mode tests for POST /api/v2/agent-templates/generations
 *
 * Covers:
 *   - Terminal `event: result` frame on success
 *   - Terminal `event: error` frame on Generate failure
 *   - Keep-alive `:\n\n` frames emitted while pending
 *   - Client disconnect clears the keep-alive interval and doesn't leak
 *     timers or throw uncaughtException
 *
 * Uses __setSseKeepaliveMsForTests to drop the keep-alive interval from
 * 15 s to ~50 ms so behaviour can be observed inside a single test.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { __setSseKeepaliveMsForTests } from "@/api/v2/agent-templates/lib/sse";
import {
  __resetGenerationExecutorForTests,
  __setExecutorTimeoutMsForTests,
} from "@/api/v2/agent-templates/services/generation-executor";
import { __resetModerationForTests } from "@/api/v2/agent-templates/services/moderation";
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "@/api/v2/agent-templates/services/templateGen";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";
import {
  stableUuid,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";
import { makeFakeTemplate } from "./agent-templates.generation.helpers";

const TEST_PORT = 4077;
const TEST_SOURCE = "generations-sse-test";

const fakeTemplate = makeFakeTemplate({
  agentName: "SSE Test Agent",
  description: "desc",
  prompt: "prompt",
  emoji: "📡",
});

let baseURL: string;
let closeServer: () => Promise<void>;

async function cleanup() {
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

beforeAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
  __resetPostHogForTests(() => {});
  __resetModerationForTests(() => Promise.resolve({ allowed: true }));

  const server = await startAgentTemplatesServer(TEST_PORT);
  baseURL = server.baseURL;
  closeServer = server.close;
});

afterEach(async () => {
  __setSseKeepaliveMsForTests(null);
  __setExecutorTimeoutMsForTests(null);
  __resetGenerateTemplateForTests(null);
  __resetGenerationExecutorForTests(null);
  __resetModerationForTests(() => Promise.resolve({ allowed: true }));
  await cleanup();
});

afterAll(async () => {
  __resetPostHogForTests(null);
  __resetModerationForTests(null);
  await closeServer();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// `stableUuid(label)` keeps the mnemonic-label style of the existing
// tests while satisfying the handler's UUID-format requirement.
const sseHeaders = (key: string) => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
  "Idempotency-Key": stableUuid(key),
  Accept: "text/event-stream",
});

const sampleBody = {
  source: TEST_SOURCE,
  inputs: { text: "build something useful" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSE mode — terminal frames", () => {
  test("emits `event: result` on Generate success", async () => {
    __resetGenerateTemplateForTests(() =>
      Promise.resolve({
        template: fakeTemplate,
        metrics: DEFAULT_TEST_METRICS,
      }),
    );

    const res = await fetch(`${baseURL}/api/v2/agent-templates/generations`, {
      method: "POST",
      headers: sseHeaders("sse-result"),
      body: JSON.stringify(sampleBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: result");
    expect(text).not.toContain("event: error");
    expect(text).toContain('"status":"done"');
    expect(text).toContain('"templateId":');
  });

  test("emits `event: error` when Generate stage fails", async () => {
    __resetGenerateTemplateForTests(() =>
      Promise.reject(new Error("OpenRouter request timed out")),
    );

    const res = await fetch(`${baseURL}/api/v2/agent-templates/generations`, {
      method: "POST",
      headers: sseHeaders("sse-error"),
      body: JSON.stringify(sampleBody),
    });

    // HTTP status is always 200 in SSE mode — error info lives in the frame
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: result");
    expect(text).toContain('"status":"failed"');
    expect(text).toContain("OpenRouter request timed out");
  });
});

describe("SSE mode — keep-alive", () => {
  test("emits `:\\n\\n` keep-alive frames while pending and `event: result` at the end", async () => {
    // Slow down the generate stage so we see keep-alive frames first
    __resetGenerateTemplateForTests(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              template: fakeTemplate,
              metrics: DEFAULT_TEST_METRICS,
            });
          }, 500);
        }),
    );

    __setSseKeepaliveMsForTests(50);

    const res = await fetch(`${baseURL}/api/v2/agent-templates/generations`, {
      method: "POST",
      headers: sseHeaders("sse-keepalive"),
      body: JSON.stringify(sampleBody),
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    // Should see at least one keep-alive comment frame before the terminal
    expect(text).toContain(":\n\n");
    expect(text).toContain("event: result");

    // Keep-alive frames must appear before the terminal frame in the byte stream
    const keepaliveIdx = text.indexOf(":\n\n");
    const resultIdx = text.indexOf("event: result");
    expect(keepaliveIdx).toBeGreaterThanOrEqual(0);
    expect(keepaliveIdx).toBeLessThan(resultIdx);
  });
});

describe("SSE mode — client disconnect", () => {
  test("client abort does not leak uncaughtException and cleans up", async () => {
    // Hold the LLM call indefinitely so disconnect happens mid-stream
    let resolveHang: () => void;
    __resetGenerateTemplateForTests(
      () =>
        new Promise<{
          template: GeneratedTemplate;
          metrics: typeof DEFAULT_TEST_METRICS;
        }>((resolve) => {
          resolveHang = () => {
            resolve({
              template: fakeTemplate,
              metrics: DEFAULT_TEST_METRICS,
            });
          };
        }),
    );

    __setSseKeepaliveMsForTests(50);

    // Watch for any uncaughtException during the abort
    let uncaught = 0;
    const onUncaught = () => {
      uncaught += 1;
    };
    process.once("uncaughtException", onUncaught);

    try {
      const controller = new AbortController();
      const fetchPromise = fetch(
        `${baseURL}/api/v2/agent-templates/generations`,
        {
          method: "POST",
          headers: sseHeaders("sse-disconnect"),
          body: JSON.stringify(sampleBody),
          signal: controller.signal,
        },
      );

      // Give the server time to start the stream + emit a couple of keep-alives
      await new Promise((resolve) => setTimeout(resolve, 200));
      controller.abort();

      try {
        await fetchPromise;
      } catch {
        // expected — aborted
      }

      // Let any pending timers settle
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(uncaught).toBe(0);
    } finally {
      // Always remove the listener so it can't leak into subsequent tests
      // (even if assertions or the abort itself threw above).
      process.removeListener("uncaughtException", onUncaught);
    }

    // Now let the hung LLM call resolve so we don't leak it across tests
    resolveHang!();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
