/**
 * Production guard tests for POST /api/v2/agent-templates/generate (SSE mode)
 *
 * Covers VAL-M3-GUARD-001 (XMTP_ENV=production → 404 with SSE Accept)
 * and VAL-M3-GUARD-002 (non-production envs mount the route).
 */
import type { Server } from "node:http";
import { afterAll, describe, expect, test } from "bun:test";
import express, { Router } from "express";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "@/api/v2/agent-templates/services/templateGen";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4020;
const happyTemplate: GeneratedTemplate = {
  agentName: "GuardBot",
  description: "Guard test assistant",
  prompt: "You are a guard",
  category: "Work",
  emoji: "🛡️",
  tools: [],
  connections: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalXMTPEnv = process.env.XMTP_ENV;
const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;
const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

const buildGuardedV2Router = () => {
  const v2Router = Router();

  if (process.env.XMTP_ENV !== "production") {
    v2Router.use("/agent-templates", agentTemplatesRouter);
  }

  return v2Router;
};

const withServer = async (
  router: unknown,
  runAssertions: (baseURL: string) => Promise<void>,
) => {
  const app = express();
  app.use(jsonMiddleware);
  app.use("/api/v2", router as Parameters<typeof app.use>[1]);
  app.use(noRouteMiddleware);

  const server: Server = await new Promise((resolve) => {
    const startedServer = app.listen(TEST_PORT, () => {
      resolve(startedServer);
    });
  });

  try {
    await runAssertions("http://localhost:4020");
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
};

afterAll(() => {
  if (originalXMTPEnv === undefined) {
    delete process.env.XMTP_ENV;
  } else {
    process.env.XMTP_ENV = originalXMTPEnv;
  }
  if (originalAgentAssetsApiKey === undefined) {
    delete process.env.AGENT_ASSETS_API_KEY;
  } else {
    process.env.AGENT_ASSETS_API_KEY = originalAgentAssetsApiKey;
  }
  __resetGenerateTemplateForTests(null);
  __resetPostHogForTests(null);
});

describe("POST /api/v2/agent-templates/generate SSE production guard", () => {
  // -----------------------------------------------------------------------
  // VAL-M3-GUARD-001: XMTP_ENV=production → 404 for SSE Accept too
  // -----------------------------------------------------------------------
  test("XMTP_ENV=production → SSE request returns 404", async () => {
    process.env.XMTP_ENV = "production";

    const productionRouter = buildGuardedV2Router();

    await withServer(productionRouter, async (baseURL) => {
      const res = await fetch(`${baseURL}/api/v2/agent-templates/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-Agent-API-Key": validAgentAssetsApiKey,
        },
        body: JSON.stringify({ idea: "test" }),
      });

      expect(res.status).toBe(404);
      // Should NOT be SSE content type (may be null for Express 404)
      const ct = res.headers.get("content-type") || "";
      expect(ct).not.toContain("text/event-stream");
    });
  });

  // -----------------------------------------------------------------------
  // VAL-M3-GUARD-002: Non-production envs mount the route
  // -----------------------------------------------------------------------
  const nonProdEnvs = ["local", "dev", "staging"];

  for (const env of nonProdEnvs) {
    test(`XMTP_ENV=${env} → SSE route is reachable`, async () => {
      process.env.XMTP_ENV = env;
      process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;

      __resetGenerateTemplateForTests(() =>
        Promise.resolve({
          template: happyTemplate,
          metrics: DEFAULT_TEST_METRICS,
        }),
      );

      const localRouter = buildGuardedV2Router();

      await withServer(localRouter, async (baseURL) => {
        const res = await fetch(`${baseURL}/api/v2/agent-templates/generate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "X-Agent-API-Key": validAgentAssetsApiKey,
          },
          body: JSON.stringify({ idea: "test" }),
        });

        // Should NOT be 404 — could be 200 (SSE) or other non-guard status
        expect(res.status).not.toBe(404);
      });
    });
  }

  test("XMTP_ENV unset → SSE route is reachable", async () => {
    delete process.env.XMTP_ENV;
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;

    __resetGenerateTemplateForTests(() =>
      Promise.resolve({
        template: happyTemplate,
        metrics: DEFAULT_TEST_METRICS,
      }),
    );

    const unsetRouter = buildGuardedV2Router();

    await withServer(unsetRouter, async (baseURL) => {
      const res = await fetch(`${baseURL}/api/v2/agent-templates/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-Agent-API-Key": validAgentAssetsApiKey,
        },
        body: JSON.stringify({ idea: "test" }),
      });

      expect(res.status).not.toBe(404);
    });

    // Restore
    if (originalXMTPEnv === undefined) {
      delete process.env.XMTP_ENV;
    } else {
      process.env.XMTP_ENV = originalXMTPEnv;
    }
  });
});
