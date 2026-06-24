/**
 * Tests for the agent-variant (Axis A) routing seam in POST /agents/join.
 *
 * When a join carries options.variantId for a registered variant with an
 * ephemeral worker, the dispatch must (1) route to the variant's worker instead
 * of the default, (2) present the ephemeral create secret (F7), (3) carry
 * metadata.variant for the profile stamp, and (4) NOT forward variantId in the
 * options the runtime sees. XMTP_ENV is "local" under tests/setup, so the
 * dev-gate is open. Needs the test DB (the variant row); runs in CI.
 */

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
} from "vitest";
import { __setAssistantConfigOverridesForTests } from "@/api/v2/agents/handlers/assistant-config";
import { joinHandler } from "@/api/v2/agents/handlers/join";
import { joinStatusHandler } from "@/api/v2/agents/handlers/join-status";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";

const DEFAULT_URL = "https://assistants.test.local";
const VARIANT_SLUG = "pr-test-join-variant";
const VARIANT_URL = `https://ephemeral-${VARIANT_SLUG}.convos.fun`;
const RUNTIME_DEFAULT_SLUG = "pr-test-join-axisb";
const EXPECTED_SECRET = "test-ephemeral-create-secret"; // tests/setup.ts default
const DEFAULT_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

type RecordedCall = {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};
const calls: RecordedCall[] = [];

let mockFetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;

function testAccountMiddleware(
  _req: Request,
  res: ExpressResponse,
  next: NextFunction,
) {
  res.locals.accountId = DEFAULT_ACCOUNT_ID;
  next();
}

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use(testAccountMiddleware);
app.post("/api/v2/agents/join", joinHandler);
app.get("/api/v2/agents/join/:instanceId", joinStatusHandler);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function record(url: string, init?: RequestInit): void {
  calls.push({
    url,
    method: init?.method,
    headers: (init?.headers ?? {}) as Record<string, string>,
    body:
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null,
  });
}

// Record every call, then respond: POST → { instanceId }, GET (status poll) →
// joined, so the handler completes.
function defaultMock(url: string, init?: RequestInit): Promise<Response> {
  record(url, init);
  if (init?.method === "POST") {
    return Promise.resolve(jsonResponse(200, { instanceId: "inst-variant" }));
  }
  return Promise.resolve(
    jsonResponse(200, {
      instanceId: "inst-variant",
      joinStatus: "joined",
      inboxId: "inbox-variant",
      conversationId: "conv-variant",
    }),
  );
}

let server: Server;
let baseURL: string;

const post = (body: unknown) =>
  originalFetch(`${baseURL}/api/v2/agents/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const postDispatch = () => calls.find((c) => c.method === "POST");

beforeAll(async () => {
  await prisma.agentVariant.deleteMany({
    where: { slug: { in: [VARIANT_SLUG, RUNTIME_DEFAULT_SLUG] } },
  });
  await prisma.agentVariant.createMany({
    data: [
      {
        slug: VARIANT_SLUG,
        label: "Q+A",
        whatToTest: "asks first",
        status: "ready",
        assistantWorkerUrl: VARIANT_URL,
        builderPromptSlug: "qa-flow-v2",
        prUrl: "https://github.com/x/y/pull/1",
        branch: "b",
        commit: "c",
      },
      {
        // Axis-B-only variant: no ephemeral worker → routes to the default.
        slug: RUNTIME_DEFAULT_SLUG,
        label: "Prompt only",
        whatToTest: "builder prompt only",
        status: "ready",
        assistantWorkerUrl: null,
        builderPromptSlug: "qa-flow-v2",
        prUrl: "https://github.com/x/y/pull/2",
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
    where: { slug: { in: [VARIANT_SLUG, RUNTIME_DEFAULT_SLUG] } },
  });
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

beforeEach(() => {
  calls.length = 0;
  __setAssistantConfigOverridesForTests({
    assistantApiUrl: DEFAULT_URL,
    assistantApiKey: "test-assistant-key",
    joinWaitBudgetMs: 200,
    joinPollIntervalMs: 20,
  });
  mockFetchImpl = defaultMock;
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    mockFetchImpl(url, init)) as typeof fetch;
});

describe("POST /agents/join — agent variant routing (Axis A)", () => {
  test("routes to the variant worker, presents the secret, stamps metadata, strips variantId", async () => {
    const res = await post({
      slug: "join-token-abc",
      options: { variantId: VARIANT_SLUG, skipGreeting: true },
    });
    expect(res.status).toBeLessThan(500);

    const dispatch = postDispatch();
    if (!dispatch) throw new Error("no POST dispatch recorded");

    // (1) routed to the variant's ephemeral worker, not the default
    expect(dispatch.url).toBe(`${VARIANT_URL}/api/assistants`);
    // (2) presented the ephemeral create secret (F7)
    expect(dispatch.headers["x-ephemeral-create-secret"]).toBe(EXPECTED_SECRET);
    // (3) carried the variant descriptor for the profile stamp
    const meta = dispatch.body?.metadata as { variant?: string } | undefined;
    expect(meta?.variant).toBeTruthy();
    expect(JSON.parse(meta?.variant ?? "{}")).toMatchObject({
      slug: VARIANT_SLUG,
      label: "Q+A",
      prUrl: "https://github.com/x/y/pull/1",
    });
    // (4) variantId is NOT forwarded to the runtime; skipGreeting still is
    const opts = (dispatch.body?.options ?? {}) as Record<string, unknown>;
    expect(opts).not.toHaveProperty("variantId");
    expect(opts.skipGreeting).toBe(true);
  });

  test("an Axis-B-only variant (no worker) routes to the default, no secret", async () => {
    const res = await post({
      slug: "join-token-def",
      options: { variantId: RUNTIME_DEFAULT_SLUG },
    });
    expect(res.status).toBeLessThan(500);

    const dispatch = postDispatch();
    if (!dispatch) throw new Error("no POST dispatch recorded");
    expect(dispatch.url).toBe(`${DEFAULT_URL}/api/assistants`);
    expect(dispatch.headers["x-ephemeral-create-secret"]).toBeUndefined();
  });
});
