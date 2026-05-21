import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import express, { Router } from "express";
import { afterAll, describe, expect, test } from "vitest";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";

type RouterWithStack = {
  stack?: Array<{
    matchers?: Array<(input: string) => false | { path: string }>;
    name?: string;
  }>;
};

const originalXMTPEnv = process.env.XMTP_ENV;

afterAll(() => {
  process.env.XMTP_ENV = originalXMTPEnv;
});

const getRouterStack = (router: unknown) =>
  (router as RouterWithStack).stack ?? [];

const buildGuardedV2Router = () => {
  const v2Router = Router();

  if (process.env.XMTP_ENV !== "production") {
    v2Router.use("/agent-templates", agentTemplatesRouter);
  }

  return v2Router;
};

const hasMountedRouter = (router: unknown, path: string) =>
  getRouterStack(router).some(
    (layer) =>
      layer.name === "router" &&
      layer.matchers?.some((matcher) => Boolean(matcher(path))),
  );

const withServer = async (
  router: unknown,
  runAssertions: (baseURL: string) => Promise<void>,
) => {
  const app = express();
  app.use(pinoMiddleware);
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

describe("agent templates production guard", () => {
  test("v2 index uses the raw production deny-list guard and kebab paths", () => {
    const source = readFileSync(
      new URL("../src/api/v2/index.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('process.env.XMTP_ENV !== "production"');
    expect(source).toContain(
      'v2Router.use("/agent-templates", agentTemplatesRouter)',
    );
    expect(source).not.toContain("/agent_templates");
    expect(source).not.toMatch(
      /import\s+\{[^}]*XMTP_ENV[^}]*\}\s+from\s+["']@\/config["']/,
    );
  });

  test("router registrations match the current milestone", () => {
    expect(getRouterStack(agentTemplatesRouter).length).toBeGreaterThan(0);
  });

  test("production does not mount the router and non-production mounts the current router", async () => {
    process.env.XMTP_ENV = "production";
    const productionRouter = buildGuardedV2Router();
    expect(hasMountedRouter(productionRouter, "/agent-templates")).toBe(false);

    await withServer(productionRouter, async (baseURL) => {
      // In production the router isn't mounted at all → noRouteMiddleware
      // returns 404 before any auth runs.
      const templatesResponse = await fetch(
        `${baseURL}/api/v2/agent-templates`,
      );
      expect(templatesResponse.status).toBe(404);

      // Same guarantee for the async generation surface.
      const generationsPost = await fetch(
        `${baseURL}/api/v2/agent-templates/generations`,
        { method: "POST" },
      );
      expect(generationsPost.status).toBe(404);

      const generationsGet = await fetch(
        `${baseURL}/api/v2/agent-templates/generations/anything`,
      );
      expect(generationsGet.status).toBe(404);
    });

    process.env.XMTP_ENV = "local";
    const localRouter = buildGuardedV2Router();
    expect(hasMountedRouter(localRouter, "/agent-templates")).toBe(true);

    await withServer(localRouter, async (baseURL) => {
      // The agent-templates read/generation routes are public now, so an
      // anonymous caller doesn't 401 anymore. We still want to prove the
      // router is mounted (i.e. the handler ran) instead of falling
      // through to noRouteMiddleware's bare 404. The discriminator here
      // is the response body: handlers return JSON envelopes; the
      // unmounted-production path returns 404 with an *empty* body.

      // GET /agent-templates → 200 with `data` envelope (handler ran).
      const listResponse = await fetch(`${baseURL}/api/v2/agent-templates`);
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as { data: unknown[] };
      expect(Array.isArray(listBody.data)).toBe(true);

      // GET /agent-templates/anything → 404 *with* a JSON `error` body from
      // the detail handler (mounted), vs the bare 404 with empty body that
      // noRouteMiddleware would return if the router weren't mounted.
      const detailResponse = await fetch(
        `${baseURL}/api/v2/agent-templates/anything`,
      );
      expect(detailResponse.status).toBe(404);
      const detailBody = (await detailResponse.json()) as { error: string };
      expect(detailBody.error).toBe("Agent template not found");

      // POST /generations without a body → 400 (handler's zod gate ran).
      const generationsPost = await fetch(
        `${baseURL}/api/v2/agent-templates/generations`,
        { method: "POST" },
      );
      expect(generationsPost.status).toBe(400);
    });
  });
});
