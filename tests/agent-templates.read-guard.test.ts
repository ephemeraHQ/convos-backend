import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import express, { Router } from "express";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { ADMIN_ACCOUNT_ID } from "@/utils/prefixed-id";
import { prisma } from "@/utils/prisma";

type ListEnvelope = {
  data: Array<Record<string, unknown>>;
  hasMore: boolean;
  nextCursor: string | null;
};

const originalXMTPEnv = process.env.XMTP_ENV;

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: { id: { startsWith: "tmpl_test_" } },
  });

const createTemplate = async (
  overrides: Partial<Prisma.AgentTemplateUncheckedCreateInput> & {
    id: string;
  },
) =>
  prisma.agentTemplate.create({
    data: {
      id: overrides.id,
      slug: overrides.slug ?? overrides.id.replace(/_/g, "-"),
      ownerAccountId: overrides.ownerAccountId ?? ADMIN_ACCOUNT_ID,
      forkedFromId: overrides.forkedFromId ?? null,
      agentName: overrides.agentName ?? `Template ${overrides.id}`,
      description: overrides.description ?? null,
      prompt: overrides.prompt ?? `Prompt for ${overrides.id}`,
      category: overrides.category ?? null,
      emoji: overrides.emoji ?? null,
      avatarUrl: overrides.avatarUrl ?? null,
      tools: overrides.tools ?? [],
      connections: overrides.connections ?? [],
      version: overrides.version ?? 1,
      firstPublishedAt:
        overrides.firstPublishedAt ?? new Date("2026-01-21T00:00:00.000Z"),
      status: overrides.status ?? "published",
      featured: overrides.featured ?? false,
      createdAt: overrides.createdAt ?? new Date("2026-01-21T00:00:00.000Z"),
    },
  });

const restoreXMTPEnv = () => {
  if (originalXMTPEnv === undefined) {
    delete process.env.XMTP_ENV;
    return;
  }

  process.env.XMTP_ENV = originalXMTPEnv;
};

const setXMTPEnv = (value: string | undefined) => {
  if (value === undefined) {
    delete process.env.XMTP_ENV;
    return;
  }

  process.env.XMTP_ENV = value;
};

const buildGuardedV2Router = () => {
  const v2Router = Router();

  if (process.env.XMTP_ENV !== "production") {
    v2Router.use("/agent-templates", agentTemplatesRouter);
  }

  return v2Router;
};

const withGuardedServer = async (
  envValue: string | undefined,
  runAssertions: (baseURL: string) => Promise<void>,
) => {
  setXMTPEnv(envValue);

  const app = express();
  app.use("/api/v2", buildGuardedV2Router());
  app.use(noRouteMiddleware);

  const server: Server = await new Promise((resolve) => {
    const startedServer = app.listen(4016, () => {
      resolve(startedServer);
    });
  });

  try {
    await runAssertions("http://localhost:4016");
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    restoreXMTPEnv();
  }
};

describe("Agent template read production guard", () => {
  afterAll(async () => {
    restoreXMTPEnv();
    await cleanupTemplates();
  });

  beforeEach(async () => {
    restoreXMTPEnv();
    await cleanupTemplates();
  });

  test("v2 mount block uses a raw process.env production deny-list and no config constant", () => {
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

  test("production unmounts list, detail, hashed-slug, query, and underscore read paths through noRouteMiddleware", async () => {
    await withGuardedServer("production", async (baseURL) => {
      const paths = [
        "/api/v2/agent-templates",
        "/api/v2/agent-templates/",
        "/api/v2/agent-templates/tmpl_anything",
        "/api/v2/agent-templates/slug.aaaaa",
        "/api/v2/agent-templates?limit=20",
        "/api/v2/agent_templates",
        "/api/v2/agent_templates/tmpl_anything",
      ];

      const responses = await Promise.all(
        paths.map((path) => fetch(`${baseURL}${path}`)),
      );
      const bodies = await Promise.all(
        responses.map((response) => response.text()),
      );

      expect(responses.map((response) => response.status)).toEqual(
        paths.map(() => 404),
      );
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).toBe("");
    });
  });

  test("dev, staging, local, unset, and mixed-case Production keep the list route reachable", async () => {
    await createTemplate({
      id: "tmpl_test_read_guard_reachable",
      slug: "read-guard-reachable",
    });

    const envCases = [
      { label: "dev", value: "dev" },
      { label: "staging", value: "staging" },
      { label: "local", value: "local" },
      { label: "unset", value: undefined },
      { label: "Production", value: "Production" },
    ];

    for (const envCase of envCases) {
      await withGuardedServer(envCase.value, async (baseURL) => {
        const response = await fetch(`${baseURL}/api/v2/agent-templates`);
        const body = (await response.json()) as ListEnvelope;

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(
          "application/json",
        );
        expect(Object.keys(body).sort()).toEqual([
          "data",
          "hasMore",
          "nextCursor",
        ]);
        expect(
          body.data.some((row) => row.id === "tmpl_test_read_guard_reachable"),
        ).toBe(true);

        const underscoreResponses = await Promise.all([
          fetch(`${baseURL}/api/v2/agent_templates`),
          fetch(
            `${baseURL}/api/v2/agent_templates/tmpl_test_read_guard_reachable`,
          ),
        ]);

        expect(underscoreResponses.map((res) => res.status)).toEqual([
          404, 404,
        ]);
      });
    }
  });
});
