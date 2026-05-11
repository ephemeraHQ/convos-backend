/**
 * Live-OpenRouter smoke test for POST /api/v2/agent-templates/generate
 *
 * *   With BUILDER_OPENROUTER_API_KEY set, posting { idea: "help me track shared groceries" }
 *   with Accept: text/event-stream produces a terminal `event: result` frame within 120 s,
 *   where data.agentName is non-empty and data.prompt ends with the brevity rail.
 *
 * Gated: if BUILDER_OPENROUTER_API_KEY is not set, all tests are skipped.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import { BREVITY_RAIL } from "@/api/v2/agent-templates/services/templateGen";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";

// ---------------------------------------------------------------------------
// Gate: skip entire suite if no live API key is available
// ---------------------------------------------------------------------------

const apiKey = process.env.BUILDER_OPENROUTER_API_KEY;
const SKIP = !apiKey;

const TEST_PORT = 4073;
const BASE_URL = `http://localhost:${TEST_PORT}`;

const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;

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
// Suite
// ---------------------------------------------------------------------------

describe("Live OpenRouter smoke", () => {
  let server: Server;

  beforeAll(() => {
    if (SKIP) return;

    setValidAgentApiKey();
    __resetPostHogForTests(() => {}); // no-op PostHog

    const app = express();
    app.use(pinoMiddleware);
    app.use(jsonMiddleware);
    app.use("/api/v2/agent-templates", agentTemplatesRouter);
    app.use(noRouteMiddleware);

    return new Promise<void>((resolve) => {
      server = app.listen(TEST_PORT, () => {
        resolve();
      });
    });
  });

  afterAll(() => {
    if (SKIP) return;

    restoreAgentApiKey();
    __resetPostHogForTests(null);

    return new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  test.skipIf(SKIP)(
    "SSE generate produces event: result with non-empty agentName and brevity rail within 120s",
    async () => {
      const response = await fetch(
        `${BASE_URL}/api/v2/agent-templates/generate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "X-Agent-API-Key": validAgentAssetsApiKey,
          },
          body: JSON.stringify({ idea: "help me track shared groceries" }),
          signal: AbortSignal.timeout(120_000),
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );

      // Read the full SSE stream body
      const text = await response.text();

      // Must contain a terminal `event: result` frame
      expect(text).toContain("event: result");

      // Extract the data payload from the event: result frame
      const dataMatch = text.match(/event: result\ndata: (.+)\n\n/);
      expect(dataMatch).not.toBeNull();

      const payload = JSON.parse(dataMatch![1]);

      // agentName must be non-empty
      expect(typeof payload.agentName).toBe("string");
      expect(payload.agentName.length).toBeGreaterThan(0);

      // prompt must end with the brevity rail
      expect(payload.prompt.endsWith(BREVITY_RAIL)).toBe(true);

      // connections must be an empty array (server-injected)
      expect(Array.isArray(payload.connections)).toBe(true);
      expect(payload.connections).toHaveLength(0);
    },
    { timeout: 120_000 },
  );
});
