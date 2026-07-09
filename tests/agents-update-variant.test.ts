import type { Server } from "node:http";
import express, {
  type Response as ExpressResponse,
  type NextFunction,
  type Request,
} from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { __setAssistantConfigOverridesForTests } from "@/api/v2/agents/handlers/assistant-config";
import { updateAgentVariantHandler } from "@/api/v2/agents/handlers/update-variant";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";

const ASSISTANT_URL = "https://assistants.test.local";
const ASSISTANT_KEY = "assistant-key";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const VARIANT_SLUG = "pr-test-update-variant";
const FAILED_SLUG = "pr-test-update-failed";
const ALL_SLUGS = [VARIANT_SLUG, FAILED_SLUG];

type RecordedCall = {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};

const calls: RecordedCall[] = [];
const originalFetch = globalThis.fetch;

function testAccountMiddleware(
  _req: Request,
  res: ExpressResponse,
  next: NextFunction,
) {
  res.locals.accountId = ACCOUNT_ID;
  next();
}

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use(testAccountMiddleware);
app.patch("/api/v2/agents/:instanceId/variant", updateAgentVariantHandler);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function record(url: string | URL, init?: RequestInit): void {
  calls.push({
    url: String(url),
    method: init?.method,
    headers: (init?.headers ?? {}) as Record<string, string>,
    body:
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null,
  });
}

let server: Server;
let baseURL: string;

function patchVariant(instanceId: string, body: unknown): Promise<Response> {
  return originalFetch(
    `${baseURL}/api/v2/agents/${encodeURIComponent(instanceId)}/variant`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeAll(async () => {
  await prisma.agentVariant.deleteMany({
    where: { slug: { in: ALL_SLUGS } },
  });
  await prisma.agentVariant.createMany({
    data: [
      {
        slug: VARIANT_SLUG,
        label: "Variant Update",
        whatToTest: "profile switch",
        status: "ready",
        assistantWorkerUrl: null,
        builderPromptSlug: null,
        prUrl: "https://github.com/x/y/pull/10",
        branch: "b",
        commit: "c",
      },
      {
        slug: FAILED_SLUG,
        label: "Failed",
        whatToTest: "not selectable",
        status: "failed",
        assistantWorkerUrl: null,
        builderPromptSlug: null,
        prUrl: "https://github.com/x/y/pull/11",
        branch: "b",
        commit: "c",
      },
    ],
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Failed to resolve test server address");
      }
      baseURL = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  __setAssistantConfigOverridesForTests({});
  await prisma.agentVariant.deleteMany({
    where: { slug: { in: ALL_SLUGS } },
  });
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

beforeEach(() => {
  calls.length = 0;
  vi.restoreAllMocks();
  __setAssistantConfigOverridesForTests({
    assistantApiUrl: ASSISTANT_URL,
    assistantApiKey: ASSISTANT_KEY,
  });
  globalThis.fetch = vi.fn(async (url, init) => {
    record(url, init);
    return jsonResponse(200, { ok: true, variant: null });
  }) as typeof fetch;
});

describe("PATCH /agents/:instanceId/variant", () => {
  test("resolves a live variant and forwards its public descriptor", async () => {
    const instanceId = "22222222-2222-4222-8222-222222222222";
    const res = await patchVariant(instanceId, { variantId: VARIANT_SLUG });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      instanceId,
      variantId: VARIANT_SLUG,
      applied: "profile_metadata",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${ASSISTANT_URL}/api/assistants/${instanceId}/variant`,
    );
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${ASSISTANT_KEY}`);
    expect(calls[0]?.body?.ownerAccountId).toBe(ACCOUNT_ID);
    expect(JSON.parse(String(calls[0]?.body?.variant))).toEqual({
      slug: VARIANT_SLUG,
      label: "Variant Update",
      whatToTest: "profile switch",
      prUrl: "https://github.com/x/y/pull/10",
    });
  });

  test("sends null to clear the profile variant", async () => {
    const instanceId = "33333333-3333-4333-8333-333333333333";
    const res = await patchVariant(instanceId, { variantId: null });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      instanceId,
      variantId: null,
      applied: "profile_metadata",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      ownerAccountId: ACCOUNT_ID,
      variant: null,
    });
  });

  test("rejects unknown or non-live variants before calling the Worker", async () => {
    const instanceId = "44444444-4444-4444-8444-444444444444";

    const unknown = await patchVariant(instanceId, {
      variantId: "pr-test-update-missing",
    });
    expect(unknown.status).toBe(404);

    const failed = await patchVariant(instanceId, { variantId: FAILED_SLUG });
    expect(failed.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("maps Worker ownership failures through as forbidden", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      record(url, init);
      return jsonResponse(403, { error: "forbidden" });
    }) as typeof fetch;

    const res = await patchVariant("55555555-5555-4555-8555-555555555555", {
      variantId: null,
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "ASSISTANT_VARIANT_UPDATE_FAILED",
    });
  });
});
