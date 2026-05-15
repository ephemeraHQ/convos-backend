import type { Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";

let mockFetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;

const ASSISTANT_URL = "https://assistants.test.local";
const ASSISTANT_KEY = "test-assistant-key";

const originalAssistantUrl = process.env.ASSISTANT_API_URL;
const originalAssistantKey = process.env.ASSISTANT_API_KEY;

const { joinHandler } = await import("@/api/v2/agents/handlers/join");
const { joinStatusHandler } = await import(
  "@/api/v2/agents/handlers/join-status"
);

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
  const baseURL = "http://localhost:4012";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4012, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;

    if (originalAssistantUrl !== undefined) {
      process.env.ASSISTANT_API_URL = originalAssistantUrl;
    } else {
      delete process.env.ASSISTANT_API_URL;
    }
    if (originalAssistantKey !== undefined) {
      process.env.ASSISTANT_API_KEY = originalAssistantKey;
    } else {
      delete process.env.ASSISTANT_API_KEY;
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    process.env.ASSISTANT_API_URL = ASSISTANT_URL;
    process.env.ASSISTANT_API_KEY = ASSISTANT_KEY;

    mockFetchImpl = () => Promise.reject(new Error("unmocked fetch"));
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      mockFetchImpl(url, init)) as typeof fetch;
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
      process.env.ASSISTANT_API_URL = "";

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

    test("dispatches POST /api/assistants and returns instanceId", async () => {
      mockFetchImpl = (url, init) => {
        expect(url).toBe(`${ASSISTANT_URL}/api/assistants`);
        expect(init?.method).toBe("POST");

        const headers = init?.headers as Record<string, string>;
        expect(headers["Content-Type"]).toBe("application/json");
        expect(headers.Authorization).toBe(`Bearer ${ASSISTANT_KEY}`);

        const body = JSON.parse(init?.body as string) as {
          name: string;
          instructions: string;
          joinUrl: string;
        };
        expect(body.name).toBe("Assistant");
        expect(body.instructions).toBe("You are a helpful assistant.");
        expect(body.joinUrl).toContain("?i=test-slug");

        return Promise.resolve(
          jsonResponse(200, { instanceId: "inst-xyz" }),
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
      expect(data.joined).toBe(false);
      expect(data.instanceId).toBe("inst-xyz");
    });

    test("forwards custom instructions to /api/assistants", async () => {
      mockFetchImpl = (_url, init) => {
        const body = JSON.parse(init?.body as string) as {
          instructions: string;
        };
        expect(body.instructions).toBe("Be terse.");
        return Promise.resolve(
          jsonResponse(200, { instanceId: "inst-1" }),
        );
      };

      const res = await post({ slug: "x", instructions: "Be terse." });
      expect(res.status).toBe(200);
    });

    test("omits Authorization header when ASSISTANT_API_KEY is empty", async () => {
      process.env.ASSISTANT_API_KEY = "";

      mockFetchImpl = (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBeUndefined();
        return Promise.resolve(
          jsonResponse(200, { instanceId: "inst-2" }),
        );
      };

      const res = await post({ slug: "y" });
      expect(res.status).toBe(200);
    });

    test("strips trailing slashes from ASSISTANT_API_URL", async () => {
      process.env.ASSISTANT_API_URL = `${ASSISTANT_URL}///`;

      mockFetchImpl = (url) => {
        expect(url).toBe(`${ASSISTANT_URL}/api/assistants`);
        return Promise.resolve(
          jsonResponse(200, { instanceId: "inst-3" }),
        );
      };

      const res = await post({ slug: "z" });
      expect(res.status).toBe(200);
    });

    test("returns 503 NO_AGENTS_AVAILABLE when upstream 503s", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(503, { error: "no capacity" }));

      const res = await post({ slug: "a" });
      expect(res.status).toBe(503);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("NO_AGENTS_AVAILABLE");
    });

    test("returns 502 on upstream 500", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(500, { error: "boom" }));

      const res = await post({ slug: "a" });
      expect(res.status).toBe(502);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("AGENT_PROVISION_FAILED");
    });

    test("returns 502 on malformed upstream response", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(200, { wrong: "shape" }));

      const res = await post({ slug: "a" });
      expect(res.status).toBe(502);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("AGENT_PROVISION_FAILED");
    });

    test("returns 504 on upstream timeout", async () => {
      mockFetchImpl = () =>
        Promise.reject(
          new DOMException("The operation was aborted", "TimeoutError"),
        );

      const res = await post({ slug: "a" });
      expect(res.status).toBe(504);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.error).toBe("AGENT_POOL_TIMEOUT");
    });
  });

  // --- GET /api/v2/agents/join/:instanceId ---

  describe("GET /api/v2/agents/join/:instanceId", () => {
    test("returns 503 when ASSISTANT_API_URL not configured", async () => {
      process.env.ASSISTANT_API_URL = "";

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
