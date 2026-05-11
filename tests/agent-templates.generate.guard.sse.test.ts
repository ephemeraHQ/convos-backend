/**
 * Production guard tests for POST /api/v2/agent-templates/generate (SSE mode)
 *
 */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express, { Router } from "express";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
// Mock persistDraftTemplate at the module-singleton seam
// ---------------------------------------------------------------------------

const FAKE_PERSISTED = (template: GeneratedTemplate, ownerAccountId: string) =>
  Promise.resolve({
    id: "00000000-0000-4000-8000-000000000099",
    slug: "guardbot.abcde",
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

  const server: Server = await new Promise((resolve, reject) => {
    const startedServer = app.listen(0, () => {
      resolve(startedServer);
    });
    startedServer.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine server port");
  }
  const baseURL = `http://localhost:${address.port}`;

  try {
    await runAssertions(baseURL);
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
  __resetPersistForTests(null);
});

describe("POST /api/v2/agent-templates/generate SSE production guard", () => {
  beforeAll(() => {
    // Stub PostHog and persist so no real captures or database writes occur
    __resetPostHogForTests(() => {});
    __resetPersistForTests(FAKE_PERSISTED);
  });

  // -----------------------------------------------------------------------
  // XMTP_ENV=production → 404 for SSE Accept too
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
  // Non-production envs mount the route
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
