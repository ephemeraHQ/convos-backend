/**
 * SSE keep-alive cadence tests for POST /api/v2/agent-templates/generate
 *
 * Covers VAL-M3-SSE-005: keep-alive `:\n\n` comments emitted approximately
 * every 15 000 ms while generateTemplate is pending. With a 16+ s mock
 * resolve, at least one keep-alive precedes the terminal frame.
 *
 * Timeout: 30 s per test (long waits required for keep-alive cadence).
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unnecessary-condition */
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
import { __resetPersistForTests } from "@/api/v2/agent-templates/handlers/generate-template";
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "@/api/v2/agent-templates/services/templateGen";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4018;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const KEEPALIVE_INTERVAL = 15_000;

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const happyTemplate: GeneratedTemplate = {
  agentName: "SlowBot",
  description: "A slow but sure assistant",
  prompt: "You think deeply",
  category: "Work",
  emoji: "🤔",
  tools: ["Search"],
  connections: [],
};

// ---------------------------------------------------------------------------
// Mock persistDraftTemplate at the module-singleton seam
// ---------------------------------------------------------------------------

const FAKE_PERSISTED = (template: GeneratedTemplate, ownerAccountId: string) =>
  Promise.resolve({
    id: "tmpl_fakePersistedId1234567890ab",
    slug: "slowbot.abcde",
    ownerAccountId,
    forkedFromId: null,
    agentName: template.agentName,
    description: template.description || null,
    prompt: template.prompt,
    category: template.category || null,
    emoji: template.emoji || null,
    avatarUrl: null,
    tools: template.tools,
    connections: template.connections,
    version: 1,
    firstPublishedAt: null,
    status: "draft",
    featured: false,
    createdAt: new Date("2026-05-08T00:00:00Z"),
    updatedAt: new Date("2026-05-08T00:00:00Z"),
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;
const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

const setValidAgentApiKey = () => {
  process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
};

const restoreAgentApiKey = () => {
  if (originalAgentAssetsApiKey === undefined) {
    delete process.env.AGENT_ASSETS_API_KEY;
  } else {
    process.env.AGENT_ASSETS_API_KEY = originalAgentAssetsApiKey;
  }
};

/** Collect all chunks from a streaming response into a single string. */
const collectSSE = async (res: Response): Promise<string> => {
  const chunks: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return chunks.join("");
};

/** Read chunks as they arrive, recording timestamps. */
const collectSSEWithTimestamps = async (
  res: Response,
): Promise<{ text: string; timestamp: number }[]> => {
  const events: { text: string; timestamp: number }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const t0 = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    events.push({ text: chunk, timestamp: Date.now() - t0 });
  }
  return events;
};

// ---------------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------------

const app = express();
app.set("case sensitive routing", true);
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/agent-templates", agentTemplatesRouter);
app.use(noRouteMiddleware);

let server: Server;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("POST /api/v2/agent-templates/generate SSE keep-alive cadence", () => {
  beforeAll(async () => {
    setValidAgentApiKey();
    __resetPostHogForTests(() => {});
    // Stub persist so no real database writes occur
    __resetPersistForTests(FAKE_PERSISTED);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(TEST_PORT, () => {
        resolve(s);
      });
    });
  });

  afterAll(async () => {
    __resetGenerateTemplateForTests(null);
    __resetPostHogForTests(null);
    __resetPersistForTests(null);
    restoreAgentApiKey();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    // Default: delayed mock that takes 16.5s (longer than keep-alive interval)
    __resetGenerateTemplateForTests(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ template: happyTemplate, metrics: DEFAULT_TEST_METRICS });
          }, 16_500);
        }),
    );
  });

  // -----------------------------------------------------------------------
  // VAL-M3-SSE-005: Keep-alive frames every ~15 000 ms
  // -----------------------------------------------------------------------
  test("with 16.5s mock, at least one keep-alive appears before terminal frame", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({ idea: "slow test" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await collectSSE(res);

    // At least one keep-alive comment (`:\n\n`) must appear
    expect(body).toContain(":\n\n");

    // The keep-alive must appear BEFORE the terminal frame
    const kaIndex = body.indexOf(":\n\n");
    const resultIndex = body.indexOf("event: result");
    expect(resultIndex).toBeGreaterThan(-1);
    expect(kaIndex).toBeLessThan(resultIndex);
  }, 30_000);

  test("keep-alive comment format is exactly :\\n\\n (SSE comment line)", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({ idea: "format test" }),
    });

    const body = await collectSSE(res);

    // Count keep-alive comments (lines that are just `:` followed by newline)
    const keepAliveCount = (body.match(/^:\n\n/gm) || []).length;
    // With a 16.5s delay and 15s interval, we expect 1 keep-alive
    expect(keepAliveCount).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("keep-alive timing is approximately 15s between frames", async () => {
    // Use a longer mock (31.5s) to get 2 keep-alives
    __resetGenerateTemplateForTests(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ template: happyTemplate, metrics: DEFAULT_TEST_METRICS });
          }, 31_500);
        }),
    );

    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({ idea: "timing test" }),
    });

    const events = await collectSSEWithTimestamps(res);

    // Find keep-alive chunks
    const keepAliveEvents = events.filter((e) => e.text.includes(":\n\n"));
    expect(keepAliveEvents.length).toBeGreaterThanOrEqual(2);

    // Verify timing between consecutive keep-alives is ~15s (±2s tolerance)
    if (keepAliveEvents.length >= 2) {
      const delta = keepAliveEvents[1].timestamp - keepAliveEvents[0].timestamp;
      expect(delta).toBeGreaterThanOrEqual(KEEPALIVE_INTERVAL - 2_000);
      expect(delta).toBeLessThanOrEqual(KEEPALIVE_INTERVAL + 2_000);
    }
  }, 45_000);

  test("no keep-alive when generateTemplate resolves quickly", async () => {
    // Quick mock (100ms) — no keep-alive expected
    __resetGenerateTemplateForTests(() =>
      Promise.resolve({
        template: { ...happyTemplate, agentName: "QuickBot" },
        metrics: DEFAULT_TEST_METRICS,
      }),
    );

    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({ idea: "quick test" }),
    });

    const body = await collectSSE(res);

    // With sub-15s resolve, no keep-alive should be emitted
    expect(body).not.toContain(":\n\n");
    expect(body).toContain("event: result");
  }, 10_000);
});
