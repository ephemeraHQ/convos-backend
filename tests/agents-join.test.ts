import type { Server } from "node:http";
import type { AgentTemplate } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import express, {
  type Response as ExpressResponse,
  type NextFunction,
  type Request,
} from "express";
import { __setAssistantConfigOverridesForTests } from "@/api/v2/agents/handlers/assistant-config";
import {
  __setTemplateFinderForTests,
  joinHandler,
} from "@/api/v2/agents/handlers/join";
import { joinStatusHandler } from "@/api/v2/agents/handlers/join-status";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";

let mockFetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;

const ASSISTANT_URL = "https://assistants.test.local";
const ASSISTANT_KEY = "test-assistant-key";
const TEST_ACCOUNT_HEADER = "x-test-account-id";

// `/api/v2/agents/join` is mounted behind `authMiddleware` + `requireAccount`
// in production, which populate and require `res.locals.accountId` (403
// otherwise). Standing up real JWT auth in this fetch-mocked test would be
// noise; instead default a placeholder accountId so every test mirrors
// production's authenticated-only contract, and let individual tests
// override identity via a header.
const DEFAULT_TEST_ACCOUNT_ID = "default-test-account";
function testAccountMiddleware(
  req: Request,
  res: ExpressResponse,
  next: NextFunction,
) {
  res.locals.accountId =
    req.header(TEST_ACCOUNT_HEADER) ?? DEFAULT_TEST_ACCOUNT_ID;
  next();
}

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use(testAccountMiddleware);
app.post("/api/v2/agents/join", joinHandler);
app.get("/api/v2/agents/join/:instanceId", joinStatusHandler);

const baseTemplate = (
  overrides: Partial<AgentTemplate> = {},
): AgentTemplate => ({
  id: "22222222-2222-4222-8222-222222222222",
  slug: "brewski",
  ownerAccountId: "owner-account-1",
  forkedFromId: null,
  agentName: "Brewski",
  description: "A friendly barista.",
  prompt: "You are Brewski.",
  category: null,
  emoji: "☕",
  avatarUrl: "https://cdn.example.com/brewski.png",
  tools: [],
  connections: [],
  version: 1,
  firstPublishedAt: new Date("2026-01-01T00:00:00.000Z"),
  status: "published",
  featured: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("agents join (assistant API)", () => {
  let server: Server;
  const baseURL = "http://localhost:4015";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4015, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    __setAssistantConfigOverridesForTests({});

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    __setAssistantConfigOverridesForTests({
      assistantApiUrl: ASSISTANT_URL,
      assistantApiKey: ASSISTANT_KEY,
      joinWaitBudgetMs: 200,
      joinPollIntervalMs: 20,
    });

    mockFetchImpl = () => Promise.reject(new Error("unmocked fetch"));
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      mockFetchImpl(url, init)) as typeof fetch;
  });

  afterEach(() => {
    __setAssistantConfigOverridesForTests({});
    __setTemplateFinderForTests(null);
  });

  const post = (body: unknown, opts: { accountId?: string } = {}) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // Send the header whenever `accountId` is explicitly provided —
    // including the empty string, which exercises the handler's "no
    // identity in context" 401 path. When omitted, the test middleware
    // defaults to `DEFAULT_TEST_ACCOUNT_ID` so the common happy path
    // mirrors production's authenticated-only contract.
    if (opts.accountId !== undefined)
      headers[TEST_ACCOUNT_HEADER] = opts.accountId;
    return originalFetch(`${baseURL}/api/v2/agents/join`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  };

  const getStatus = (instanceId: string) =>
    originalFetch(
      `${baseURL}/api/v2/agents/join/${encodeURIComponent(instanceId)}`,
      { method: "GET" },
    );

  // --- POST /api/v2/agents/join ---

  describe("POST /api/v2/agents/join", () => {
    test("returns 503 when ASSISTANT_API_URL not configured", async () => {
      __setAssistantConfigOverridesForTests({
        assistantApiUrl: "",
        assistantApiKey: ASSISTANT_KEY,
      });

      const res = await post({ slug: "abc" });
      expect(res.status).toBe(503);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("AGENT_POOL_UNAVAILABLE");
    });

    test("returns 400 when slug is missing", async () => {
      const res = await post({});
      expect(res.status).toBe(400);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_REQUEST");
    });

    test("returns joined:true once upstream reports joined", async () => {
      mockFetchImpl = (url, init) => {
        if (init?.method === "POST") {
          expect(url).toBe(`${ASSISTANT_URL}/api/assistants`);
          const headers = init.headers as Record<string, string>;
          expect(headers.Authorization).toBe(`Bearer ${ASSISTANT_KEY}`);

          const body = JSON.parse(init.body as string) as {
            joinUrl: string;
            template: unknown;
            ownerAccountId?: string;
            options?: Record<string, unknown>;
          };
          // Bare join (no templateId) → `template: null` on the wire.
          // No `name`/`instructions`/`metadata` fields — the upstream
          // worker reads agent identity off `template` when present.
          expect(body.joinUrl).toContain("?i=test-slug");
          expect(body.template).toBeNull();
          // No options passed → no `options` field in the upstream payload.
          expect(body.options).toBeUndefined();

          return Promise.resolve(jsonResponse(200, { instanceId: "inst-xyz" }));
        }
        // GET poll — mirror real upstream shape (numeric epoch-ms
        // timestamps) so schema drift on `createdAt`/`destroyedAt` surfaces
        // in the inline poller too.
        expect(url).toBe(`${ASSISTANT_URL}/api/assistants/inst-xyz`);
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-xyz",
            joinStatus: "joined",
            inboxId: "inbox-1",
            conversationId: "conv-1",
            joinFailureReason: null,
            createdAt: 1715000000000,
            destroyedAt: null,
          }),
        );
      };

      const res = await post({ slug: "test-slug" });
      expect(res.status).toBe(200);

      const data = (await res.json()) as {
        success: boolean;
        joined: boolean;
        instanceId: string;
      };
      expect(data.success).toBe(true);
      expect(data.joined).toBe(true);
      expect(data.instanceId).toBe("inst-xyz");
    });

    test("polls past 'starting' states until joined", async () => {
      let pollCount = 0;
      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-1" }));
        }
        pollCount += 1;
        if (pollCount < 3) {
          return Promise.resolve(
            jsonResponse(200, {
              instanceId: "inst-1",
              joinStatus: "starting",
            }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-1",
            joinStatus: "joined",
          }),
        );
      };

      const res = await post({ slug: "s" });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { joined: boolean };
      expect(data.joined).toBe(true);
      expect(pollCount).toBeGreaterThanOrEqual(3);
    });

    test("returns joined:false + instanceId when wait budget elapses", async () => {
      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          return Promise.resolve(
            jsonResponse(200, { instanceId: "inst-slow" }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-slow",
            joinStatus: "starting",
          }),
        );
      };

      const res = await post({ slug: "slow" });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        joined: boolean;
        instanceId: string;
      };
      expect(data.success).toBe(true);
      expect(data.joined).toBe(false);
      expect(data.instanceId).toBe("inst-slow");
    });

    test("returns 502 when upstream reports failed", async () => {
      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-bad" }));
        }
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-bad",
            joinStatus: "failed",
            joinFailureReason: "container boot failure",
          }),
        );
      };

      const res = await post({ slug: "x" });
      expect(res.status).toBe(502);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("AGENT_PROVISION_FAILED");
    });

    test("rejects `instructions` field — templates are the unit now", async () => {
      // Closes the silent-drop footgun from when `templateId` + `instructions`
      // would discard the caller's prompt without feedback. Strict body
      // schema now rejects any unknown key, including `instructions`.
      const res = await post({ slug: "x", instructions: "Be terse." });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("INVALID_REQUEST");
    });

    test("returns 403 when accountId is missing from request context", async () => {
      // Defense-in-depth: the route sits behind `authMiddleware` +
      // `requireAccount` in production, so the handler's inline guard is
      // unreachable through normal routing. The test exercises it anyway
      // by sending an explicit empty `x-test-account-id` header,
      // simulating a hypothetical middleware-order regression. Mirrors
      // `requireAccount` exactly (403 + `{ error: "Account required" }`).
      const res = await post({ slug: "x" }, { accountId: "" });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Account required");
    });

    test("forwards options.skipGreeting upstream when provided", async () => {
      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as {
            options?: Record<string, unknown>;
          };
          expect(body.options).toEqual({ skipGreeting: true });
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-sg" }));
        }
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-sg",
            joinStatus: "joined",
          }),
        );
      };

      const res = await post({
        slug: "x",
        options: { skipGreeting: true },
      });
      expect(res.status).toBe(200);
    });

    test("forwards options.onboarding upstream when provided", async () => {
      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as {
            options?: Record<string, unknown>;
          };
          expect(body.options).toEqual({ onboarding: "assistant-builder" });
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-ob" }));
        }
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-ob",
            joinStatus: "joined",
          }),
        );
      };

      const res = await post({
        slug: "x",
        options: { onboarding: "assistant-builder" },
      });
      expect(res.status).toBe(200);
    });

    test("forwards both options together when both provided", async () => {
      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as {
            options?: Record<string, unknown>;
          };
          expect(body.options).toEqual({
            skipGreeting: false,
            onboarding: "assistant-builder",
          });
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-bo" }));
        }
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-bo",
            joinStatus: "joined",
          }),
        );
      };

      const res = await post({
        slug: "x",
        options: { skipGreeting: false, onboarding: "assistant-builder" },
      });
      expect(res.status).toBe(200);
    });

    test("rejects unknown keys inside options", async () => {
      const res = await post({
        slug: "x",
        options: { skipGreeting: true, mystery: "value" },
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("INVALID_REQUEST");
    });

    test("omits Authorization header when ASSISTANT_API_KEY is empty", async () => {
      __setAssistantConfigOverridesForTests({
        assistantApiUrl: ASSISTANT_URL,
        assistantApiKey: "",
        joinWaitBudgetMs: 200,
        joinPollIntervalMs: 20,
      });

      mockFetchImpl = (_url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers.Authorization).toBeUndefined();
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-na" }));
        }
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-na",
            joinStatus: "joined",
          }),
        );
      };

      const res = await post({ slug: "y" });
      expect(res.status).toBe(200);
    });

    test("strips trailing slashes from ASSISTANT_API_URL", async () => {
      __setAssistantConfigOverridesForTests({
        assistantApiUrl: `${ASSISTANT_URL}///`,
        assistantApiKey: ASSISTANT_KEY,
        joinWaitBudgetMs: 200,
        joinPollIntervalMs: 20,
      });

      mockFetchImpl = (url, init) => {
        if (init?.method === "POST") {
          expect(url).toBe(`${ASSISTANT_URL}/api/assistants`);
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-3" }));
        }
        expect(url).toBe(`${ASSISTANT_URL}/api/assistants/inst-3`);
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-3",
            joinStatus: "joined",
          }),
        );
      };

      const res = await post({ slug: "z" });
      expect(res.status).toBe(200);
    });

    test("returns 503 NO_AGENTS_AVAILABLE when dispatch 503s", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(503, { error: "no capacity" }));

      const res = await post({ slug: "a" });
      expect(res.status).toBe(503);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("NO_AGENTS_AVAILABLE");
    });

    test("returns 502 AGENT_PROVISION_FAILED when dispatch 404s (misconfig)", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(404, { error: "not found" }));

      const res = await post({ slug: "a" });
      expect(res.status).toBe(502);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("AGENT_PROVISION_FAILED");
    });

    test("returns 502 on dispatch 500", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(500, { error: "boom" }));

      const res = await post({ slug: "a" });
      expect(res.status).toBe(502);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("AGENT_PROVISION_FAILED");
    });

    test("returns 502 on malformed dispatch response", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(200, { wrong: "shape" }));

      const res = await post({ slug: "a" });
      expect(res.status).toBe(502);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("AGENT_PROVISION_FAILED");
    });

    test("returns 504 on dispatch timeout", async () => {
      mockFetchImpl = () =>
        Promise.reject(
          new DOMException("The operation was aborted", "TimeoutError"),
        );

      const res = await post({ slug: "a" });
      expect(res.status).toBe(504);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("AGENT_POOL_TIMEOUT");
    });

    test("treats per-poll errors as non-fatal and falls back to pending", async () => {
      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-err" }));
        }
        return Promise.reject(new Error("ECONNREFUSED"));
      };

      const res = await post({ slug: "err" });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        joined: boolean;
        instanceId: string;
      };
      expect(data.joined).toBe(false);
      expect(data.instanceId).toBe("inst-err");
    });

    // ----- templateId resolution -----

    test("forwards joining user's accountId as top-level ownerAccountId on bare join", async () => {
      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as {
            ownerAccountId?: string;
          };
          expect(body.ownerAccountId).toBe("user-bare");
          return Promise.resolve(
            jsonResponse(200, { instanceId: "inst-bare" }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, { instanceId: "inst-bare", joinStatus: "joined" }),
        );
      };

      const res = await post({ slug: "x" }, { accountId: "user-bare" });
      expect(res.status).toBe(200);
    });

    test("templateId path rides the AgentTemplate as a top-level `template` field", async () => {
      const template = baseTemplate({ agentName: "Brewski" });
      __setTemplateFinderForTests(() => Promise.resolve(template));

      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as {
            joinUrl: string;
            template: Record<string, unknown>;
            ownerAccountId?: string;
          };
          expect(body.ownerAccountId).toBe("user-1");
          // Full AgentTemplate JSON (including prompt) rides as a single
          // top-level field. No `name`/`instructions`/`metadata` split.
          expect(body.template).toBeDefined();
          expect(body.template.id).toBe(template.id);
          expect(body.template.agentName).toBe("Brewski");
          expect(body.template.prompt).toBe(template.prompt);
          // Template's own ownerAccountId is stripped — runtime doesn't
          // need it. Joining user's account rides as the top-level field.
          expect(body.template.ownerAccountId).toBeUndefined();
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-t" }));
        }
        return Promise.resolve(
          jsonResponse(200, { instanceId: "inst-t", joinStatus: "joined" }),
        );
      };

      const res = await post(
        { slug: "x", templateId: template.id },
        { accountId: "user-1" },
      );
      expect(res.status).toBe(200);
    });

    test("caller-supplied name + profileImage overlay agentName/avatarUrl inside template", async () => {
      const template = baseTemplate({
        agentName: "Brewski",
        avatarUrl: "https://cdn.example.com/brewski.png",
      });
      __setTemplateFinderForTests(() => Promise.resolve(template));

      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as {
            template: Record<string, unknown>;
          };
          expect(body.template.agentName).toBe("Custom Name");
          expect(body.template.avatarUrl).toBe(
            "https://cdn.example.com/custom.png",
          );
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-o" }));
        }
        return Promise.resolve(
          jsonResponse(200, { instanceId: "inst-o", joinStatus: "joined" }),
        );
      };

      const res = await post(
        {
          slug: "x",
          templateId: template.id,
          name: "Custom Name",
          profileImage: "https://cdn.example.com/custom.png",
        },
        { accountId: "user-1" },
      );
      expect(res.status).toBe(200);
    });

    test("returns 404 when templateId does not resolve", async () => {
      __setTemplateFinderForTests(() => Promise.resolve(null));

      const res = await post(
        { slug: "x", templateId: "33333333-3333-4333-8333-333333333333" },
        { accountId: "user-1" },
      );
      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("TEMPLATE_NOT_FOUND");
    });

    test("returns 410 when template is archived", async () => {
      __setTemplateFinderForTests(() =>
        Promise.resolve(baseTemplate({ status: "archived" })),
      );

      const res = await post(
        { slug: "x", templateId: "33333333-3333-4333-8333-333333333333" },
        { accountId: "user-1" },
      );
      expect(res.status).toBe(410);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("TEMPLATE_ARCHIVED");
    });

    test("returns 500 when template lookup throws", async () => {
      // `findUnique` itself returns `null` for missing records, not a
      // throw — so the throwing branch only fires on connection / driver
      // errors. The guard exists so transient DB failures surface as a
      // clean error code instead of an unhandled promise rejection.
      __setTemplateFinderForTests(() =>
        Promise.reject(new Error("ECONNREFUSED")),
      );

      const res = await post(
        { slug: "x", templateId: "33333333-3333-4333-8333-333333333333" },
        { accountId: "user-1" },
      );
      expect(res.status).toBe(500);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("TEMPLATE_LOOKUP_FAILED");
    });

    test("draft template: owner can use it", async () => {
      __setTemplateFinderForTests(() =>
        Promise.resolve(
          baseTemplate({ status: "draft", ownerAccountId: "user-1" }),
        ),
      );

      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-d" }));
        }
        return Promise.resolve(
          jsonResponse(200, { instanceId: "inst-d", joinStatus: "joined" }),
        );
      };

      const res = await post(
        { slug: "x", templateId: "33333333-3333-4333-8333-333333333333" },
        { accountId: "user-1" },
      );
      expect(res.status).toBe(200);
    });

    test("draft template: non-owner gets 403", async () => {
      __setTemplateFinderForTests(() =>
        Promise.resolve(
          baseTemplate({ status: "draft", ownerAccountId: "someone-else" }),
        ),
      );

      const res = await post(
        { slug: "x", templateId: "33333333-3333-4333-8333-333333333333" },
        { accountId: "user-1" },
      );
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("TEMPLATE_FORBIDDEN");
    });

    test("rejects templateId + onboarding=assistant-builder (mutually exclusive)", async () => {
      // Validation happens before the template lookup, so no finder needed.
      const res = await post(
        {
          slug: "x",
          templateId: "33333333-3333-4333-8333-333333333333",
          options: { onboarding: "assistant-builder" },
        },
        { accountId: "user-1" },
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("INVALID_REQUEST");
    });

    test("templateId + onboarding=first-impression composes fine", async () => {
      __setTemplateFinderForTests(() => Promise.resolve(baseTemplate()));

      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as {
            options?: { onboarding?: string };
            template?: unknown;
          };
          expect(body.options?.onboarding).toBe("first-impression");
          expect(body.template).toBeDefined();
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-fi" }));
        }
        return Promise.resolve(
          jsonResponse(200, { instanceId: "inst-fi", joinStatus: "joined" }),
        );
      };

      const res = await post(
        {
          slug: "x",
          templateId: "33333333-3333-4333-8333-333333333333",
          options: { onboarding: "first-impression" },
        },
        { accountId: "user-1" },
      );
      expect(res.status).toBe(200);
    });
  });

  // --- GET /api/v2/agents/join/:instanceId ---

  describe("GET /api/v2/agents/join/:instanceId", () => {
    test("returns 503 when ASSISTANT_API_URL not configured", async () => {
      __setAssistantConfigOverridesForTests({
        assistantApiUrl: "",
        assistantApiKey: ASSISTANT_KEY,
      });

      const res = await getStatus("inst-1");
      expect(res.status).toBe(503);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("AGENT_POOL_UNAVAILABLE");
    });

    test("returns joined=true when upstream reports joined", async () => {
      mockFetchImpl = (url, init) => {
        expect(url).toBe(`${ASSISTANT_URL}/api/assistants/inst-99`);
        expect(init?.method).toBe("GET");
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe(`Bearer ${ASSISTANT_KEY}`);

        // Mirror the real upstream shape (numeric epoch-ms timestamps) so
        // schema drift on `createdAt` / `destroyedAt` would surface here.
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-99",
            joinStatus: "joined",
            inboxId: "inbox-1",
            conversationId: "conv-1",
            joinFailureReason: null,
            createdAt: 1715000000000,
            destroyedAt: null,
          }),
        );
      };

      const res = await getStatus("inst-99");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        joined: boolean;
        joinStatus: string;
        inboxId: string | null;
        conversationId: string | null;
      };
      expect(data.success).toBe(true);
      expect(data.joined).toBe(true);
      expect(data.joinStatus).toBe("joined");
      expect(data.inboxId).toBe("inbox-1");
      expect(data.conversationId).toBe("conv-1");
    });

    test("returns joined=false when status is starting", async () => {
      mockFetchImpl = () =>
        Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-99",
            joinStatus: "starting",
          }),
        );

      const res = await getStatus("inst-99");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        joined: boolean;
        joinStatus: string;
        inboxId: string | null;
        conversationId: string | null;
        joinFailureReason: string | null;
      };
      expect(data.joined).toBe(false);
      expect(data.joinStatus).toBe("starting");
      expect(data.inboxId).toBeNull();
      expect(data.conversationId).toBeNull();
      expect(data.joinFailureReason).toBeNull();
    });

    test("surfaces joinFailureReason when status is failed", async () => {
      mockFetchImpl = () =>
        Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-99",
            joinStatus: "failed",
            joinFailureReason: "container boot failure",
          }),
        );

      const res = await getStatus("inst-99");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        joined: boolean;
        joinStatus: string;
        joinFailureReason: string | null;
      };
      expect(data.joined).toBe(false);
      expect(data.joinStatus).toBe("failed");
      expect(data.joinFailureReason).toBe("container boot failure");
    });

    test("returns 404 when upstream 404s", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(404, { error: "not found" }));

      const res = await getStatus("inst-missing");
      expect(res.status).toBe(404);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("INSTANCE_NOT_FOUND");
    });

    test("returns 502 on malformed upstream response", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(200, { joinStatus: "bogus" }));

      const res = await getStatus("inst-99");
      expect(res.status).toBe(502);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("JOIN_STATUS_FAILED");
    });

    test("returns 504 on upstream timeout", async () => {
      mockFetchImpl = () =>
        Promise.reject(
          new DOMException("The operation was aborted", "TimeoutError"),
        );

      const res = await getStatus("inst-99");
      expect(res.status).toBe(504);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("AGENT_POOL_TIMEOUT");
    });

    test("URL-encodes instanceId when forwarding", async () => {
      mockFetchImpl = (url) => {
        expect(url).toBe(
          `${ASSISTANT_URL}/api/assistants/inst%20with%20spaces`,
        );
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst with spaces",
            joinStatus: "starting",
          }),
        );
      };

      const res = await getStatus("inst with spaces");
      expect(res.status).toBe(200);
    });
  });
});
