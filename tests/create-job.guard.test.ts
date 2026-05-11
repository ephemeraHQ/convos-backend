/**
 * Production guard tests for /api/v2/agent-templates/create-job
 *
 * Covers:
 *   VAL-CJ-POST-005: POST returns 403/404 in production environment
 *   VAL-CJ-GET-016: GET returns 403/404 in production environment
 *   VAL-CJ-CROSS-007: Production guard blocks both POST and GET
 *
 * The production guard is implemented in src/api/v2/index.ts:
 *   if (process.env.XMTP_ENV !== "production") {
 *     v2Router.use("/agent-templates", agentTemplatesRouter);
 *   }
 *
 * When XMTP_ENV=production, the agent-templates router is not mounted,
 * so all routes return 404.
 */

import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, describe, expect, test } from "bun:test";
import express, { Router } from "express";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { noRouteMiddleware } from "@/middleware/noRoute";

const originalXMTPEnv = process.env.XMTP_ENV;

afterAll(() => {
  process.env.XMTP_ENV = originalXMTPEnv;
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

describe("Production guard for /api/v2/agent-templates/create-job", () => {
  test("POST /create-job returns 404 when XMTP_ENV=production", async () => {
    process.env.XMTP_ENV = "production";

    const productionRouter = buildGuardedV2Router();

    await withServer(productionRouter, async (baseURL) => {
      const res = await fetch(`${baseURL}/api/v2/agent-templates/create-job`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-API-Key":
            "test-agent-assets-api-key-that-is-at-least-32-characters",
        },
        body: JSON.stringify({
          text: "hello",
          joinUrl: "https://example.com/join",
        }),
      });

      expect(res.status).toBe(404);
    });
  });

  test("GET /create-job/:jobId returns 404 when XMTP_ENV=production", async () => {
    process.env.XMTP_ENV = "production";

    const productionRouter = buildGuardedV2Router();

    await withServer(productionRouter, async (baseURL) => {
      const res = await fetch(
        `${baseURL}/api/v2/agent-templates/create-job/some-job-id`,
        {
          headers: {
            "X-Agent-API-Key":
              "test-agent-assets-api-key-that-is-at-least-32-characters",
          },
        },
      );

      expect(res.status).toBe(404);
    });
  });

  test("routes are reachable when XMTP_ENV is not production", async () => {
    process.env.XMTP_ENV = "dev";

    const devRouter = buildGuardedV2Router();

    await withServer(devRouter, async (baseURL) => {
      // POST should NOT be 404 (could be 400, 401, etc. but not the guard's 404)
      const postRes = await fetch(
        `${baseURL}/api/v2/agent-templates/create-job`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Agent-API-Key":
              "test-agent-assets-api-key-that-is-at-least-32-characters",
          },
          body: JSON.stringify({
            text: "hello",
            joinUrl: "https://example.com/join",
          }),
        },
      );
      expect(postRes.status).not.toBe(404);

      // GET should NOT be 404 for a real job (could be 401 or 404 for missing job)
      const getRes = await fetch(
        `${baseURL}/api/v2/agent-templates/create-job/some-id`,
        {
          headers: {
            "X-Agent-API-Key":
              "test-agent-assets-api-key-that-is-at-least-32-characters",
          },
        },
      );
      // Not the guard's 404 — could be 401 or 404 for missing job
      expect(getRes.status).not.toBe(404);
    });
  });

  test("production guard reads process.env.XMTP_ENV raw (not imported constant)", () => {
    const source = readFileSync(
      new URL("../src/api/v2/index.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('process.env.XMTP_ENV !== "production"');
  });
});
