/**
 * Tests for the agent-variant runtime-routing seam in POST /agents/join.
 *
 * When a join carries options.variantId for a registered variant with an
 * ephemeral worker, the dispatch must (1) route to the variant's worker instead
 * of the default, (2) carry metadata.variant for the profile stamp, and (3) NOT
 * forward variantId in the options the runtime sees. XMTP_ENV is "local" under
 * tests/setup, so the dev-gate is open. Needs the test DB (the variant row);
 * runs in CI.
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
  vi,
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
const BAD_URL_SLUG = "pr-test-join-badurl";
const FAILED_SLUG = "pr-test-join-failed";
const MISMATCH_SLUG = "pr-test-join-mismatch";
const ALL_SLUGS = [
  VARIANT_SLUG,
  RUNTIME_DEFAULT_SLUG,
  BAD_URL_SLUG,
  FAILED_SLUG,
  MISMATCH_SLUG,
];
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
    where: { slug: { in: ALL_SLUGS } },
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
        // Explicit opt-out into the real credit path: proves the stored value
        // (not the column default) is what rides the descriptor stamp.
        skipCredits: false,
        prUrl: "https://github.com/x/y/pull/1",
        branch: "b",
        commit: "c",
      },
      {
        // Builder-prompt-only variant: no ephemeral worker → routes to the default.
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
      {
        // Untrusted worker URL (not an ephemeral-*.convos.fun origin) → the join
        // must NOT send the bearer there; it falls back to the default worker.
        slug: BAD_URL_SLUG,
        label: "Bad URL",
        whatToTest: "untrusted worker origin",
        status: "ready",
        assistantWorkerUrl: "https://evil.example.com",
        builderPromptSlug: null,
        prUrl: "https://github.com/x/y/pull/3",
        branch: "b",
        commit: "c",
      },
      {
        // A non-live (failed) variant must be ignored even with a valid URL.
        slug: FAILED_SLUG,
        label: "Failed",
        whatToTest: "retired runtime",
        status: "failed",
        assistantWorkerUrl: `https://ephemeral-${FAILED_SLUG}.convos.fun`,
        builderPromptSlug: null,
        prUrl: "https://github.com/x/y/pull/4",
        branch: "b",
        commit: "c",
      },
      {
        // Valid ephemeral host, but for a DIFFERENT slug — the bearer must not
        // go cross-PR, so this routes to the default worker.
        slug: MISMATCH_SLUG,
        label: "Mismatch",
        whatToTest: "host points at another slug",
        status: "ready",
        assistantWorkerUrl: "https://ephemeral-pr-test-join-other.convos.fun",
        builderPromptSlug: null,
        prUrl: "https://github.com/x/y/pull/5",
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

describe("POST /agents/join — agent variant runtime routing", () => {
  test("routes to the variant worker, stamps metadata, strips variantId", async () => {
    const res = await post({
      slug: "join-token-abc",
      options: { variantId: VARIANT_SLUG, skipGreeting: true },
    });
    expect(res.status).toBeLessThan(500);

    const dispatch = postDispatch();
    if (!dispatch) throw new Error("no POST dispatch recorded");

    // (1) routed to the variant's ephemeral worker, not the default
    expect(dispatch.url).toBe(`${VARIANT_URL}/api/assistants`);
    // (2) carried the variant descriptor for the profile stamp
    const meta = dispatch.body?.metadata as { variant?: string } | undefined;
    expect(meta?.variant).toBeTruthy();
    expect(JSON.parse(meta?.variant ?? "{}")).toMatchObject({
      slug: VARIANT_SLUG,
      label: "Q+A",
      prUrl: "https://github.com/x/y/pull/1",
      skipCredits: false,
    });
    // (3) variantId is NOT forwarded to the runtime; skipGreeting still is
    const opts = (dispatch.body?.options ?? {}) as Record<string, unknown>;
    expect(opts).not.toHaveProperty("variantId");
    expect(opts.skipGreeting).toBe(true);
  });

  test("a builder-prompt-only variant (no worker) routes to the default", async () => {
    const res = await post({
      slug: "join-token-def",
      options: { variantId: RUNTIME_DEFAULT_SLUG },
    });
    expect(res.status).toBeLessThan(500);

    const dispatch = postDispatch();
    if (!dispatch) throw new Error("no POST dispatch recorded");
    expect(dispatch.url).toBe(`${DEFAULT_URL}/api/assistants`);
  });

  test("a non-allowlisted worker URL routes to the default and still stamps", async () => {
    const res = await post({
      slug: "join-token-ghi",
      options: { variantId: BAD_URL_SLUG },
    });
    expect(res.status).toBeLessThan(500);

    const dispatch = postDispatch();
    if (!dispatch) throw new Error("no POST dispatch recorded");
    // The untrusted URL never receives the dispatch (nor its bearer token).
    expect(dispatch.url).toBe(`${DEFAULT_URL}/api/assistants`);
    // The descriptor stamp still applies, as for a default-runtime variant.
    const meta = dispatch.body?.metadata as { variant?: string } | undefined;
    expect(JSON.parse(meta?.variant ?? "{}")).toMatchObject({
      slug: BAD_URL_SLUG,
    });
  });

  test("a non-live (failed) variant is ignored and routes to the default", async () => {
    const res = await post({
      slug: "join-token-mno",
      options: { variantId: FAILED_SLUG },
    });
    expect(res.status).toBeLessThan(500);

    const dispatch = postDispatch();
    if (!dispatch) throw new Error("no POST dispatch recorded");
    // Filtered out by status, so no routing and no descriptor stamp.
    expect(dispatch.url).toBe(`${DEFAULT_URL}/api/assistants`);
    expect(dispatch.body?.metadata).toBeUndefined();
  });

  test("a variant whose worker host is a different slug routes to the default", async () => {
    const res = await post({
      slug: "join-token-pqr",
      options: { variantId: MISMATCH_SLUG },
    });
    expect(res.status).toBeLessThan(500);

    const dispatch = postDispatch();
    if (!dispatch) throw new Error("no POST dispatch recorded");
    // Host is a valid ephemeral but not THIS variant's — bearer stays on default.
    expect(dispatch.url).toBe(`${DEFAULT_URL}/api/assistants`);
  });
});

describe("GET /agents/join/:instanceId — variant status routing", () => {
  test("polls the variant worker when the client carries variantId", async () => {
    const res = await originalFetch(
      `${baseURL}/api/v2/agents/join/inst-x?variantId=${VARIANT_SLUG}`,
    );
    expect(res.status).toBe(200);
    const statusGet = calls.find(
      (c) => c.method === "GET" && c.url.includes("/api/assistants/inst-x"),
    );
    if (!statusGet) throw new Error("no status GET recorded");
    expect(statusGet.url).toBe(`${VARIANT_URL}/api/assistants/inst-x`);
  });

  test("polls the default worker without variantId", async () => {
    const res = await originalFetch(`${baseURL}/api/v2/agents/join/inst-y`);
    expect(res.status).toBe(200);
    const statusGet = calls.find(
      (c) => c.method === "GET" && c.url.includes("/api/assistants/inst-y"),
    );
    if (!statusGet) throw new Error("no status GET recorded");
    expect(statusGet.url).toBe(`${DEFAULT_URL}/api/assistants/inst-y`);
  });

  test("falls back to the default worker for a non-live variant", async () => {
    const res = await originalFetch(
      `${baseURL}/api/v2/agents/join/inst-z?variantId=${FAILED_SLUG}`,
    );
    expect(res.status).toBe(200);
    const statusGet = calls.find(
      (c) => c.method === "GET" && c.url.includes("/api/assistants/inst-z"),
    );
    if (!statusGet) throw new Error("no status GET recorded");
    expect(statusGet.url).toBe(`${DEFAULT_URL}/api/assistants/inst-z`);
  });
});

// Placed last on purpose: this spies the shared prisma.agentVariant.findFirst,
// and mockRestore is unreliable for the prisma delegate method here — so running
// it before the routing tests leaks a stubbed findFirst into them. With it last,
// no test runs after, and the file isolation (singleFork + isolate) keeps it
// from bleeding into other files.
describe("POST /agents/join — variant lookup degradation", () => {
  test("a DB error on the variant lookup degrades to the default worker", async () => {
    const findFirstSpy = vi
      .spyOn(prisma.agentVariant, "findFirst")
      .mockRejectedValueOnce(new Error("db unreachable"));
    try {
      const res = await post({
        slug: "join-token-jkl",
        options: { variantId: VARIANT_SLUG },
      });
      expect(res.status).toBeLessThan(500);
      const dispatch = postDispatch();
      if (!dispatch) throw new Error("no POST dispatch recorded");
      expect(dispatch.url).toBe(`${DEFAULT_URL}/api/assistants`);
      expect(dispatch.body?.metadata).toBeUndefined();
    } finally {
      findFirstSpy.mockRestore();
    }
  });
});
