import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { agentVariantsRouter } from "@/api/v2/agent-variants/agent-variants.router";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

// XMTP_ENV is "local" under tests/setup.ts, so the dev-gate is open — these
// tests exercise the dev path (GET returns rows, mutations reach the auth
// check). The prod branch (GET → [], mutations → 404) is a single
// XMTP_ENV === "production" guard and isn't worth a module-mock here.

const AGENT_KEY = "test-agent-api-key-that-is-at-least-32-characters";
const SLUG_PREFIX = "pr-test-variant-";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/agent-variants", agentVariantsRouter);
app.use(noRouteMiddleware);

let server: Server;
const baseURL = "http://localhost:4071";

const cleanup = () =>
  prisma.agentVariant.deleteMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
  });

const registryHeaders = (key: string | null) => ({
  "Content-Type": "application/json",
  ...(key === null ? {} : { "X-Agent-API-Key": key }),
});

const jwtHeaders = async () => ({
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-agent-variants",
    accountId: ADMIN_ACCOUNT_ID,
  }),
});

const body = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  label: "Q+A",
  whatToTest: "Asks clarifying questions first.",
  status: "ready",
  assistantWorkerUrl: `https://ephemeral-${slug}.convos.fun`,
  builderPromptSlug: "qa-flow-v2",
  prUrl: "https://github.com/xmtplabs/convos-assistants/pull/1",
  branch: "saul/qa",
  commit: "abc1234",
  ...over,
});

beforeAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(AGENT_KEY);
  await new Promise<void>((resolve) => {
    server = app.listen(4071, () => {
      resolve();
    });
  });
  await cleanup();
});

afterEach(cleanup);

afterAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(undefined);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

describe("POST /v2/agent-variants", () => {
  test("creates a variant with the scoped registry key", async () => {
    const slug = `${SLUG_PREFIX}create`;
    const res = await fetch(`${baseURL}/api/v2/agent-variants`, {
      method: "POST",
      headers: registryHeaders(AGENT_KEY),
      body: JSON.stringify(body(slug)),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.slug).toBe(slug);
    expect(json.status).toBe("ready");
    expect("updatedAt" in json).toBe(false);
  });

  test("upserts (second POST on the same slug updates, not duplicates)", async () => {
    const slug = `${SLUG_PREFIX}upsert`;
    await fetch(`${baseURL}/api/v2/agent-variants`, {
      method: "POST",
      headers: registryHeaders(AGENT_KEY),
      body: JSON.stringify(body(slug, { status: "building", commit: "old" })),
    });
    const res = await fetch(`${baseURL}/api/v2/agent-variants`, {
      method: "POST",
      headers: registryHeaders(AGENT_KEY),
      body: JSON.stringify(body(slug, { status: "ready", commit: "new" })),
    });
    expect(res.status).toBe(200);
    const row = await prisma.agentVariant.findUnique({ where: { slug } });
    expect(row?.commit).toBe("new");
    expect(row?.status).toBe("ready");
  });

  test("401 without the registry key", async () => {
    const res = await fetch(`${baseURL}/api/v2/agent-variants`, {
      method: "POST",
      headers: registryHeaders(null),
      body: JSON.stringify(body(`${SLUG_PREFIX}noauth`)),
    });
    expect(res.status).toBe(401);
  });

  test("401 with a wrong registry key", async () => {
    const res = await fetch(`${baseURL}/api/v2/agent-variants`, {
      method: "POST",
      headers: registryHeaders("wrong-key-but-also-at-least-32-characters!!"),
      body: JSON.stringify(body(`${SLUG_PREFIX}wrong`)),
    });
    expect(res.status).toBe(401);
  });

  test("400 on an invalid body (unknown key)", async () => {
    const res = await fetch(`${baseURL}/api/v2/agent-variants`, {
      method: "POST",
      headers: registryHeaders(AGENT_KEY),
      body: JSON.stringify({ ...body(`${SLUG_PREFIX}bad`), bogus: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v2/agent-variants", () => {
  test("returns ready+building newest-first, excludes failed", async () => {
    await prisma.agentVariant.createMany({
      data: [
        {
          ...body(`${SLUG_PREFIX}old`, { status: "ready" }),
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
        {
          ...body(`${SLUG_PREFIX}new`, { status: "building" }),
          createdAt: new Date("2026-06-20T00:00:00.000Z"),
        },
        { ...body(`${SLUG_PREFIX}gone`, { status: "failed" }) },
      ],
    });
    const res = await fetch(`${baseURL}/api/v2/agent-variants`, {
      headers: await jwtHeaders(),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { slug: string }[] };
    const slugs = json.data
      .filter((v) => v.slug.startsWith(SLUG_PREFIX))
      .map((v) => v.slug);
    expect(slugs).toEqual([`${SLUG_PREFIX}new`, `${SLUG_PREFIX}old`]);
    expect(slugs).not.toContain(`${SLUG_PREFIX}gone`);
  });

  test("401 without a JWT", async () => {
    const res = await fetch(`${baseURL}/api/v2/agent-variants`);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /v2/agent-variants/:slug", () => {
  test("deletes an existing variant (204) and is idempotent on a missing one", async () => {
    const slug = `${SLUG_PREFIX}del`;
    await prisma.agentVariant.create({ data: body(slug) });

    const first = await fetch(`${baseURL}/api/v2/agent-variants/${slug}`, {
      method: "DELETE",
      headers: registryHeaders(AGENT_KEY),
    });
    expect(first.status).toBe(204);
    expect(
      await prisma.agentVariant.findUnique({ where: { slug } }),
    ).toBeNull();

    // Re-delete a now-missing slug — teardown is idempotent.
    const second = await fetch(`${baseURL}/api/v2/agent-variants/${slug}`, {
      method: "DELETE",
      headers: registryHeaders(AGENT_KEY),
    });
    expect(second.status).toBe(204);
  });

  test("401 without the registry key", async () => {
    const res = await fetch(
      `${baseURL}/api/v2/agent-variants/${SLUG_PREFIX}x`,
      { method: "DELETE", headers: registryHeaders(null) },
    );
    expect(res.status).toBe(401);
  });
});
