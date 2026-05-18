import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import { __setAssistantConfigOverridesForTests } from "@/api/v2/agents/handlers/assistant-config";
import { joinHandler } from "@/api/v2/agents/handlers/join";
import { joinStatusHandler } from "@/api/v2/agents/handlers/join-status";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";

let mockFetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;

const ASSISTANT_URL = "https://assistants.test.local";
const ASSISTANT_KEY = "test-assistant-key";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.post("/api/v2/agents/join", joinHandler);
app.get("/api/v2/agents/join/:instanceId", joinStatusHandler);

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
  });

  const post = (body: unknown) =>
    originalFetch(`${baseURL}/api/v2/agents/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

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
            name: string;
            instructions: string;
            joinUrl: string;
            options?: Record<string, unknown>;
          };
          expect(body.name).toBe("Assistant");
          expect(body.instructions).toBe("You are a helpful assistant.");
          expect(body.joinUrl).toContain("?i=test-slug");
          // No options passed → no `options` field in the upstream payload.
          expect(body.options).toBeUndefined();

          return Promise.resolve(jsonResponse(200, { instanceId: "inst-xyz" }));
        }
        // GET poll
        expect(url).toBe(`${ASSISTANT_URL}/api/assistants/inst-xyz`);
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-xyz",
            joinStatus: "joined",
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

    test("forwards custom instructions to /api/assistants", async () => {
      mockFetchImpl = (_url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as {
            instructions: string;
          };
          expect(body.instructions).toBe("Be terse.");
          return Promise.resolve(jsonResponse(200, { instanceId: "inst-i" }));
        }
        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-i",
            joinStatus: "joined",
          }),
        );
      };

      const res = await post({ slug: "x", instructions: "Be terse." });
      expect(res.status).toBe(200);
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

        return Promise.resolve(
          jsonResponse(200, {
            instanceId: "inst-99",
            joinStatus: "joined",
            inboxId: "inbox-1",
            conversationId: "conv-1",
            joinFailureReason: null,
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
