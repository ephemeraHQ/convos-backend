/**
 * Production guard tests for POST /api/v2/agent-templates/generate
 *
 * Covers VAL-M3-ROUTE-010 (production guard returns 404).
 * VAL-M3-GUARD-001 and VAL-M3-GUARD-002 are in the SSE feature's test file;
 * this file covers the JSON-mode guard assertion only.
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express, { Router } from "express";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { __resetPersistForTests } from "@/api/v2/agent-templates/handlers/generate-template";
import { type GeneratedTemplate } from "@/api/v2/agent-templates/services/templateGen";
import { noRouteMiddleware } from "@/middleware/noRoute";

const originalXMTPEnv = process.env.XMTP_ENV;
const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;

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

afterAll(() => {
  process.env.XMTP_ENV = originalXMTPEnv;
  if (originalAgentAssetsApiKey === undefined) {
    delete process.env.AGENT_ASSETS_API_KEY;
  } else {
    process.env.AGENT_ASSETS_API_KEY = originalAgentAssetsApiKey;
  }
  __resetPersistForTests(null);
});

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
  app.use(express.json({ limit: "50mb" }));
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

describe("POST /api/v2/agent-templates/generate production guard", () => {
  beforeAll(() => {
    // Stub persist so no real database writes occur
    __resetPersistForTests(FAKE_PERSISTED);
  });

  test("XMTP_ENV=production → POST /generate returns 404", async () => {
    process.env.XMTP_ENV = "production";

    const productionRouter = buildGuardedV2Router();

    await withServer(productionRouter, async (baseURL) => {
      const res = await fetch(`${baseURL}/api/v2/agent-templates/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-API-Key": "any-key",
        },
        body: JSON.stringify({ idea: "test" }),
      });

      expect(res.status).toBe(404);
    });
  });

  test("XMTP_ENV=local → route is reachable", async () => {
    process.env.XMTP_ENV = "local";
    process.env.AGENT_ASSETS_API_KEY =
      "test-agent-assets-api-key-that-is-at-least-32-characters";

    const localRouter = buildGuardedV2Router();

    await withServer(localRouter, async (baseURL) => {
      const res = await fetch(`${baseURL}/api/v2/agent-templates/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-API-Key":
            "test-agent-assets-api-key-that-is-at-least-32-characters",
        },
        body: JSON.stringify({ idea: "test" }),
      });

      // Should NOT be 404 — could be 200, 400, 401, or 502 depending on
      // whether the handler works, but it must not be the guard's 404.
      expect(res.status).not.toBe(404);
    });
  });

  test("production guard still reads process.env.XMTP_ENV raw", () => {
    const source = readFileSync(
      new URL("../src/api/v2/index.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('process.env.XMTP_ENV !== "production"');
  });
});
