import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import express, { Router } from "express";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken } from "@/utils/jwt";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";

const originalXMTPEnv = process.env.XMTP_ENV;

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      OR: [
        { slug: { startsWith: "write-guard-" } },
        { agentName: { startsWith: "Write Guard" } },
      ],
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
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use("/api/v2", buildGuardedV2Router());
  app.use(noRouteMiddleware);

  const server: Server = await new Promise((resolve) => {
    const startedServer = app.listen(4015, () => {
      resolve(startedServer);
    });
  });

  try {
    await runAssertions("http://localhost:4015");
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    restoreXMTPEnv();
  }
};

const authHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-agent-templates-write-guard",
    accountId: ADMIN_ACCOUNT_ID,
  }),
});

const createBody = (label: string) =>
  JSON.stringify({
    agentName: `Write Guard ${label}`,
    prompt: `Prompt for ${label}`,
    slug: `write-guard-${label}`,
  });

describe("Agent template write production guard", () => {
  afterAll(async () => {
    restoreXMTPEnv();
    await cleanupTemplates();
  });

  beforeEach(async () => {
    restoreXMTPEnv();
    await cleanupTemplates();
  });

  test("v2 mount block uses the raw process.env production deny-list for agent template routes", () => {
    const source = readFileSync(
      new URL("../src/api/v2/index.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('process.env.XMTP_ENV !== "production"');
    expect(source).toContain(
      'v2Router.use("/agent-templates", agentTemplatesRouter)',
    );
    expect(source).not.toMatch(
      /import\s+\{[^}]*XMTP_ENV[^}]*\}\s+from\s+["']@\/config["']/,
    );
  });

  test("production unmounts POST, PATCH, DELETE, and publish through noRouteMiddleware", async () => {
    await withGuardedServer("production", async (baseURL) => {
      const headers = await authHeaders();
      const fakeUuid = randomUUID();
      const requests = [
        fetch(`${baseURL}/api/v2/agent-templates`, {
          method: "POST",
          headers,
          body: createBody("production-post"),
        }),
        fetch(`${baseURL}/api/v2/agent-templates/${fakeUuid}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ description: "blocked" }),
        }),
        fetch(`${baseURL}/api/v2/agent-templates/${fakeUuid}`, {
          method: "DELETE",
          headers,
        }),
        fetch(`${baseURL}/api/v2/agent-templates/${fakeUuid}/publish`, {
          method: "POST",
          headers,
        }),
      ];

      const responses = await Promise.all(requests);
      const bodies = await Promise.all(
        responses.map((response) => response.text()),
      );

      expect(responses.map((response) => response.status)).toEqual([
        404, 404, 404, 404,
      ]);
      expect(bodies).toEqual(["", "", "", ""]);
      expect(
        await prisma.agentTemplate.count({
          where: { slug: "write-guard-production-post" },
        }),
      ).toBe(0);
    });
  });

  test("local, staging, and unset XMTP_ENV keep write endpoints reachable", async () => {
    const envCases = [
      { label: "local", value: "local" },
      { label: "staging", value: "staging" },
      { label: "unset", value: undefined },
    ];

    for (const envCase of envCases) {
      await withGuardedServer(envCase.value, async (baseURL) => {
        const authed = await fetch(`${baseURL}/api/v2/agent-templates`, {
          method: "POST",
          headers: await authHeaders(),
          body: createBody(envCase.label),
        });
        const authedBody = (await authed.json()) as { id?: string };
        expect(authed.status).toBe(201);
        expect(typeof authedBody.id).toBe("string");
        expect(authedBody.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );

        const unauthed = await fetch(`${baseURL}/api/v2/agent-templates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: createBody(`${envCase.label}-unauthed`),
        });
        expect(unauthed.status).toBe(401);
      });
    }
  });
});
