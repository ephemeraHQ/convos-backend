/**
 * Client disconnect tests for POST /api/v2/agent-templates/generate (SSE mode)
 *
 * Covers VAL-M3-DISCONNECT-001..003:
 * - In-flight generateTemplate is NOT aborted (no AbortSignal)
 * - Keep-alive write errors swallowed (no uncaughtException)
 * - clearInterval always runs (no resource leak)
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import {
  __resetGenerateTemplateForTests,
  type GeneratedTemplate,
} from "@/api/v2/agent-templates/services/templateGen";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4019;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const happyTemplate: GeneratedTemplate = {
  agentName: "DisconnectBot",
  description: "Resilient assistant",
  prompt: "You keep going",
  category: "Work",
  emoji: "💪",
  tools: ["Search"],
  connections: [],
};

// Track whether generateTemplate settled
let generateSettled = false;
let _generateSettledAt = 0;

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

describe("POST /api/v2/agent-templates/generate SSE client disconnect", () => {
  beforeAll(async () => {
    setValidAgentApiKey();
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(TEST_PORT, () => {
        resolve(s);
      });
    });
  });

  afterAll(async () => {
    __resetGenerateTemplateForTests(null);
    restoreAgentApiKey();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  // -----------------------------------------------------------------------
  // VAL-M3-DISCONNECT-001: In-flight generateTemplate is NOT aborted
  // -----------------------------------------------------------------------
  test("generateTemplate still settles after client aborts (no AbortSignal)", async () => {
    generateSettled = false;
    _generateSettledAt = 0;

    // Mock that takes 500ms and tracks settlement
    __resetGenerateTemplateForTests(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            generateSettled = true;
            _generateSettledAt = Date.now();
            resolve(happyTemplate);
          }, 500);
        }),
    );

    // Make the request and abort the client side immediately
    const controller = new AbortController();
    const resPromise = fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({ idea: "disconnect test" }),
      signal: controller.signal,
    });

    // Wait a tiny bit for the request to start, then abort the client
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    // The fetch will throw due to abort — that's expected
    try {
      await resPromise;
    } catch (err: unknown) {
      // AbortError expected
      expect((err as Error).name).toBe("AbortError");
    }

    // Wait for the generateTemplate mock to settle
    await new Promise((resolve) => setTimeout(resolve, 600));

    // generateTemplate MUST have settled despite client abort
    expect(generateSettled).toBe(true);
  }, 5_000);

  // -----------------------------------------------------------------------
  // VAL-M3-DISCONNECT-002: Keep-alive write errors are swallowed
  // -----------------------------------------------------------------------
  test("keep-alive write errors swallowed; no uncaughtException", async () => {
    // Set up an uncaughtException listener that fails the test if invoked
    let uncaughtError: Error | null = null;
    const listener = (error: Error) => {
      uncaughtError = error;
    };
    process.on("uncaughtException", listener);

    // Mock that takes 16.5s (will trigger keep-alive attempts after client is gone)
    __resetGenerateTemplateForTests(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(happyTemplate);
          }, 16_500);
        }),
    );

    const controller = new AbortController();
    const resPromise = fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({ idea: "swallow test" }),
      signal: controller.signal,
    });

    // Abort after headers arrive (so SSE stream is established)
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();

    try {
      await resPromise;
    } catch {
      // AbortError expected
    }

    // Wait for keep-alive interval to fire at least once after abort
    await new Promise((resolve) => setTimeout(resolve, 17_000));

    // Remove listener before assertion
    process.removeListener("uncaughtException", listener);

    // No uncaughtException should have been emitted
    expect(uncaughtError).toBeNull();
  }, 30_000);

  // -----------------------------------------------------------------------
  // VAL-M3-DISCONNECT-003: No resource leak after abort (clearInterval runs)
  // -----------------------------------------------------------------------
  test("active handles return to baseline after client abort + settlement", async () => {
    // Capture baseline active handles
    const baselineHandles = (process as any)._getActiveHandles()
      .length as number;

    // Mock that takes 500ms
    __resetGenerateTemplateForTests(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(happyTemplate);
          }, 500);
        }),
    );

    const controller = new AbortController();
    const resPromise = fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({ idea: "leak test" }),
      signal: controller.signal,
    });

    // Abort early
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    try {
      await resPromise;
    } catch {
      // AbortError
    }

    // Wait for generateTemplate to settle and clearInterval to run
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Active handles should be back near baseline
    const postHandles = (process as any)._getActiveHandles().length as number;
    // Allow a small margin (the server socket itself counts)
    expect(postHandles).toBeLessThanOrEqual(baselineHandles + 2);
  }, 5_000);
});
