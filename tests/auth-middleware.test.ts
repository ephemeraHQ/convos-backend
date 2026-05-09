/**
 * Auth middleware identity resolution tests (VAL-AUTH-ID-001..004)
 *
 * Tests that authOrAgentApiKeyAuth correctly sets:
 *   - res.locals.accountId = ADMIN_ACCOUNT_ID when API key auth is used (VAL-AUTH-ID-001)
 *   - res.locals.isApiKeyListener = true when API key auth is used (VAL-AUTH-ID-002)
 *   - res.locals.accountId from JWT payload when JWT auth is used (VAL-AUTH-ID-003)
 *   - requireAccount rejects when res.locals.accountId is undefined (VAL-AUTH-ID-004)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express, { type Response } from "express";
import { authOrAgentApiKeyAuth } from "@/middleware/agentAuth";
import { requireAccount } from "@/middleware/auth";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { getEffectiveOwnerId } from "@/utils/auth-helpers";
import { createJwtToken } from "@/utils/jwt";
import { ADMIN_ACCOUNT_ID } from "@/utils/prefixed-id";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";
const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;

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
      accountId: (res.locals.accountId as string | undefined) ?? null,
      isApiKeyListener:
        (res.locals.isApiKeyListener as boolean | undefined) ?? false,
    });
  });
  app.get("/test", (_req, res: Response) => {
    res.json({
      accountId: (res.locals.accountId as string | undefined) ?? null,
      isApiKeyListener:
        (res.locals.isApiKeyListener as boolean | undefined) ?? false,
    });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("authOrAgentApiKeyAuth identity resolution", () => {
  beforeAll(() => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
  });

  afterAll(() => {
    if (originalAgentAssetsApiKey === undefined) {
      delete process.env.AGENT_ASSETS_API_KEY;
    } else {
      process.env.AGENT_ASSETS_API_KEY = originalAgentAssetsApiKey;
    }
  });

  // VAL-AUTH-ID-001: API key auth sets res.locals.accountId = ADMIN_ACCOUNT_ID
  test("sets accountId to ADMIN_ACCOUNT_ID when API key auth is used", async () => {
    const app = buildTestApp([authOrAgentApiKeyAuth]);
    const server = app.listen(4030);

    try {
      const response = await fetch("http://localhost:4030/test", {
        method: "POST",
        headers: agentKeyHeaders(),
      });
      const body = (await response.json()) as LocalsBody;

      expect(response.status).toBe(200);
      expect(body.accountId).toBe(ADMIN_ACCOUNT_ID);
    } finally {
      server.close();
    }
  });

  // VAL-AUTH-ID-002: API key auth sets res.locals.isApiKeyListener = true
  test("sets isApiKeyListener = true when API key auth is used", async () => {
    const app = buildTestApp([authOrAgentApiKeyAuth]);
    const server = app.listen(4030);

    try {
      const response = await fetch("http://localhost:4030/test", {
        method: "POST",
        headers: agentKeyHeaders(),
      });
      const body = (await response.json()) as LocalsBody;

      expect(response.status).toBe(200);
      expect(body.isApiKeyListener).toBe(true);
    } finally {
      server.close();
    }
  });

  // VAL-AUTH-ID-002 (negative case): JWT auth does NOT set isApiKeyListener
  test("does NOT set isApiKeyListener when JWT auth is used", async () => {
    const app = buildTestApp([authOrAgentApiKeyAuth]);
    const server = app.listen(4030);

    try {
      const response = await fetch("http://localhost:4030/test", {
        method: "POST",
        headers: await jwtHeaders(ADMIN_ACCOUNT_ID),
      });
      const body = (await response.json()) as LocalsBody;

      expect(response.status).toBe(200);
      expect(body.isApiKeyListener).toBe(false);
    } finally {
      server.close();
    }
  });

  // VAL-AUTH-ID-003: JWT auth sets accountId from the JWT payload
  test("sets accountId from JWT payload when JWT auth is used", async () => {
    const app = buildTestApp([authOrAgentApiKeyAuth]);
    const server = app.listen(4030);

    try {
      const response = await fetch("http://localhost:4030/test", {
        method: "POST",
        headers: await jwtHeaders(ADMIN_ACCOUNT_ID),
      });
      const body = (await response.json()) as LocalsBody;

      expect(response.status).toBe(200);
      expect(body.accountId).toBe(ADMIN_ACCOUNT_ID);
    } finally {
      server.close();
    }
  });

  // JWT without accountId still authenticates (accountId is undefined)
  test("JWT without accountId authenticates but accountId is null", async () => {
    const app = buildTestApp([authOrAgentApiKeyAuth]);
    const server = app.listen(4030);

    try {
      const response = await fetch("http://localhost:4030/test", {
        method: "POST",
        headers: await jwtHeaders(), // no accountId
      });
      const body = (await response.json()) as LocalsBody;

      expect(response.status).toBe(200);
      expect(body.accountId).toBeNull();
    } finally {
      server.close();
    }
  });

  // VAL-AUTH-ID-004: requireAccount rejects when accountId is undefined
  test("requireAccount rejects (403) when accountId is undefined", async () => {
    const app = buildTestApp([authOrAgentApiKeyAuth, requireAccount]);
    const server = app.listen(4030);

    try {
      // JWT without accountId → authOrAgentApiKeyAuth passes but accountId is null
      const response = await fetch("http://localhost:4030/test", {
        method: "POST",
        headers: await jwtHeaders(), // no accountId
      });

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Account required");
    } finally {
      server.close();
    }
  });

  // requireAccount does NOT reject API key requests (accountId is set by middleware)
  test("requireAccount passes when API key auth sets accountId", async () => {
    const app = buildTestApp([authOrAgentApiKeyAuth, requireAccount]);
    const server = app.listen(4030);

    try {
      const response = await fetch("http://localhost:4030/test", {
        method: "POST",
        headers: agentKeyHeaders(),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as LocalsBody;
      expect(body.accountId).toBe(ADMIN_ACCOUNT_ID);
    } finally {
      server.close();
    }
  });

  // requireAccount passes when JWT auth with accountId sets accountId
  test("requireAccount passes when JWT auth with accountId sets accountId", async () => {
    const app = buildTestApp([authOrAgentApiKeyAuth, requireAccount]);
    const server = app.listen(4030);

    try {
      const response = await fetch("http://localhost:4030/test", {
        method: "POST",
        headers: await jwtHeaders(ADMIN_ACCOUNT_ID),
      });

      expect(response.status).toBe(200);
    } finally {
      server.close();
    }
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


