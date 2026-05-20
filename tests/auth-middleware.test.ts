/**
 * Auth middleware identity resolution tests
 *
 * Tests that authOrAgentApiKeyAuth correctly sets:
 *   - res.locals.accountId = ADMIN_ACCOUNT_ID when API key auth is used
 *   - res.locals.isApiKeyListener = true when API key auth is used
 *   - res.locals.accountId from JWT payload when JWT auth is used
 *   - requireAccount rejects when res.locals.accountId is undefined
 */

import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express, { type Response } from "express";
import {
  __setAgentAssetsApiKeyOverrideForTests,
  authOrAgentApiKeyAuth,
} from "@/middleware/agentAuth";
import { requireAccount } from "@/middleware/auth";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { getEffectiveOwnerId } from "@/utils/auth-helpers";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

// Set the test override once at module load. After commit 6f0be85,
// AGENT_ASSETS_API_KEY is cached by config.ts at import time and
// agentApiKeyAuth reads it via the override seam, so a single setup
// here covers every request in the file (the previous race comment
// no longer applies — the cached value can't drift between requests).
__setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);

const agentKeyHeaders = (key = validAgentAssetsApiKey) => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": key,
});

const jwtHeaders = async (accountId?: string) => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-auth-middleware",
    accountId,
  }),
});

type LocalsBody = {
  accountId: string | null;
  isApiKeyListener: boolean;
};

/**
 * Build a test app that captures res.locals after the middleware chain.
 * The endpoint handler returns the captured locals as JSON.
 */
function buildTestApp(middlewares: express.RequestHandler[]) {
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use(...middlewares);
  app.post("/test", (_req, res: Response) => {
    res.json({
      accountId: res.locals.accountId ?? null,
      isApiKeyListener: res.locals.isApiKeyListener ?? false,
    });
  });
  app.get("/test", (_req, res: Response) => {
    res.json({
      accountId: res.locals.accountId ?? null,
      isApiKeyListener: res.locals.isApiKeyListener ?? false,
    });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("authOrAgentApiKeyAuth identity resolution", () => {
  const baseURL = "http://localhost:4051";
  let server: Server;

  beforeAll(async () => {
    const app = buildTestApp([authOrAgentApiKeyAuth]);
    await new Promise<void>((resolve) => {
      server = app.listen(4051, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  // API key auth sets res.locals.accountId = ADMIN_ACCOUNT_ID
  test("sets accountId to ADMIN_ACCOUNT_ID when API key auth is used", async () => {
    const response = await fetch(`${baseURL}/test`, {
      method: "POST",
      headers: agentKeyHeaders(),
    });
    const body = (await response.json()) as LocalsBody;

    expect(response.status).toBe(200);
    expect(body.accountId).toBe(ADMIN_ACCOUNT_ID);
  });

  // API key auth sets res.locals.isApiKeyListener = true
  test("sets isApiKeyListener = true when API key auth is used", async () => {
    const response = await fetch(`${baseURL}/test`, {
      method: "POST",
      headers: agentKeyHeaders(),
    });
    const body = (await response.json()) as LocalsBody;

    expect(response.status).toBe(200);
    expect(body.isApiKeyListener).toBe(true);
  });

  // (negative case): JWT auth does NOT set isApiKeyListener
  test("does NOT set isApiKeyListener when JWT auth is used", async () => {
    const response = await fetch(`${baseURL}/test`, {
      method: "POST",
      headers: await jwtHeaders(ADMIN_ACCOUNT_ID),
    });
    const body = (await response.json()) as LocalsBody;

    expect(response.status).toBe(200);
    expect(body.isApiKeyListener).toBe(false);
  });

  // JWT auth sets accountId from the JWT payload
  test("sets accountId from JWT payload when JWT auth is used", async () => {
    const response = await fetch(`${baseURL}/test`, {
      method: "POST",
      headers: await jwtHeaders(ADMIN_ACCOUNT_ID),
    });
    const body = (await response.json()) as LocalsBody;

    expect(response.status).toBe(200);
    expect(body.accountId).toBe(ADMIN_ACCOUNT_ID);
  });

  // JWT without accountId still authenticates (accountId is undefined)
  test("JWT without accountId authenticates but accountId is null", async () => {
    const response = await fetch(`${baseURL}/test`, {
      method: "POST",
      headers: await jwtHeaders(), // no accountId
    });
    const body = (await response.json()) as LocalsBody;

    expect(response.status).toBe(200);
    expect(body.accountId).toBeNull();
  });
});

describe("requireAccount with authOrAgentApiKeyAuth", () => {
  const baseURL = "http://localhost:4092";
  let server: Server;

  beforeAll(async () => {
    const app = buildTestApp([authOrAgentApiKeyAuth, requireAccount]);
    await new Promise<void>((resolve) => {
      server = app.listen(4092, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  // requireAccount rejects when accountId is undefined
  test("rejects (403) when accountId is undefined", async () => {
    // JWT without accountId → authOrAgentApiKeyAuth passes but accountId is null
    const response = await fetch(`${baseURL}/test`, {
      method: "POST",
      headers: await jwtHeaders(), // no accountId
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Account required");
  });

  // requireAccount does NOT reject API key requests (accountId is set by middleware)
  test("passes when API key auth sets accountId", async () => {
    const response = await fetch(`${baseURL}/test`, {
      method: "POST",
      headers: agentKeyHeaders(),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as LocalsBody;
    expect(body.accountId).toBe(ADMIN_ACCOUNT_ID);
  });

  // requireAccount passes when JWT auth with accountId sets accountId
  test("passes when JWT auth with accountId sets accountId", async () => {
    const response = await fetch(`${baseURL}/test`, {
      method: "POST",
      headers: await jwtHeaders(ADMIN_ACCOUNT_ID),
    });

    expect(response.status).toBe(200);
  });
});

describe("getEffectiveOwnerId utility", () => {
  test("returns res.locals.accountId from response", () => {
    const mockRes = {
      locals: { accountId: ADMIN_ACCOUNT_ID },
    } as unknown as Response;

    expect(getEffectiveOwnerId(mockRes)).toBe(ADMIN_ACCOUNT_ID);
  });

  test("returns undefined when accountId is not set", () => {
    const mockRes = {
      locals: {},
    } as unknown as Response;

    expect(getEffectiveOwnerId(mockRes)).toBeUndefined();
  });
});

describe("agent-templates router auth wiring", () => {
  test("write routes require an account; read + generations routes use optional auth", () => {
    const source = readFileSync(
      new URL(
        "../src/api/v2/agent-templates/agent-templates.router.ts",
        import.meta.url,
      ),
      "utf8",
    );

    // Both middlewares are imported.
    expect(source).toContain("authOrAgentApiKeyAuth");
    expect(source).toContain("optionalAuthOrAgentApiKeyAuth");
    expect(source).toContain("requireAccount");
    expect(source).toContain('from "@/middleware/auth"');

    // Write routes (POST /, PATCH /:id, DELETE /:id, POST /:id/publish)
    // chain `authOrAgentApiKeyAuth + requireAccount`. That's 4 routes,
    // and one import, for 5 occurrences of `requireAccount` total.
    const requireAccountCount = (source.match(/requireAccount/g) ?? []).length;
    expect(requireAccountCount).toBe(5);

    expect(source).toContain("requireAccount,\n  createHandler");
    expect(source).toContain("requireAccount,\n  patchHandler");
    expect(source).toContain("requireAccount,\n  deleteHandler");
    expect(source).toContain("requireAccount,\n  publishHandler");

    // Public routes use the optional middleware: GET /, GET /:idOrUrlSlug,
    // POST /generations, GET /generations/:generationId. The optional
    // middleware MUST NOT be followed by requireAccount.
    expect(source).toContain("optionalAuthOrAgentApiKeyAuth, listHandler");
    expect(source).toContain("optionalAuthOrAgentApiKeyAuth,\n  detailHandler");
    expect(source).toContain(
      "optionalAuthOrAgentApiKeyAuth,\n  generationsPostHandler",
    );
    expect(source).toContain(
      "optionalAuthOrAgentApiKeyAuth,\n  generationsGetHandler",
    );
    expect(source).not.toMatch(
      /optionalAuthOrAgentApiKeyAuth,\s*requireAccount/,
    );
  });
});
