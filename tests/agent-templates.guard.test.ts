import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, describe, expect, test } from "bun:test";
import express, { Router } from "express";
import { agentSkillsRouter } from "@/api/v2/agent-skills/agent-skills.router";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { noRouteMiddleware } from "@/middleware/noRoute";

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
    v2Router.use("/agent-skills", agentSkillsRouter);
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
  app.use("/api/v2", router as Parameters<typeof app.use>[1]);
  app.use(noRouteMiddleware);

  const server: Server = await new Promise((resolve, reject) => {
    const startedServer = app.listen(4050, () => {
      resolve(startedServer);
    });
    startedServer.once("error", reject);
  });

  try {
    await runAssertions("http://localhost:4050");
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
};

describe("agent templates and skills production guard", () => {
  test("v2 index uses the raw production deny-list guard and kebab paths", () => {
    const source = readFileSync(
      new URL("../src/api/v2/index.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('process.env.XMTP_ENV !== "production"');
    expect(source).toContain(
      'v2Router.use("/agent-templates", agentTemplatesRouter)',
    );
    expect(source).toContain(
      'v2Router.use("/agent-skills", agentSkillsRouter)',
    );
    expect(source).not.toContain("/agent_templates");
    expect(source).not.toContain("/agent_skills");
    expect(source).not.toMatch(
      /import\s+\{[^}]*XMTP_ENV[^}]*\}\s+from\s+["']@\/config["']/,
    );
  });

  test("router shells are empty in M1", () => {
    expect(getRouterStack(agentTemplatesRouter)).toHaveLength(0);
    expect(getRouterStack(agentSkillsRouter)).toHaveLength(0);
  });

  test("production does not mount routers and non-production mounts empty routers", async () => {
    process.env.XMTP_ENV = "production";
    const productionRouter = buildGuardedV2Router();
    expect(hasMountedRouter(productionRouter, "/agent-templates")).toBe(false);
    expect(hasMountedRouter(productionRouter, "/agent-skills")).toBe(false);

    await withServer(productionRouter, async (baseURL) => {
      const [templatesResponse, skillsResponse] = await Promise.all([
        fetch(`${baseURL}/api/v2/agent-templates`),
        fetch(`${baseURL}/api/v2/agent-skills`),
      ]);

      expect(templatesResponse.status).toBe(404);
      expect(skillsResponse.status).toBe(404);
    });

    process.env.XMTP_ENV = "local";
    const localRouter = buildGuardedV2Router();
    expect(hasMountedRouter(localRouter, "/agent-templates")).toBe(true);
    expect(hasMountedRouter(localRouter, "/agent-skills")).toBe(true);

    await withServer(localRouter, async (baseURL) => {
      const paths = [
        "/api/v2/agent-templates",
        "/api/v2/agent-templates/anything",
        "/api/v2/agent-skills",
        "/api/v2/agent-skills/anything",
      ];

      const responses = await Promise.all(
        paths.map((path) => fetch(`${baseURL}${path}`)),
      );

      expect(responses.map((response) => response.status)).toEqual([
        404, 404, 404, 404,
      ]);
    });
  });
});
