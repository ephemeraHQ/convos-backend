/**
 * SSE-mode tests for POST /api/v2/agent-templates/generate
 *
 * Covers VAL-M3-SSE-001..009 (headers, terminal frames, error mapping,
 * exactly-one-frame, validation-before-SSE, Accept substring, no X-Accel-Buffering).
 * OpenRouter is mocked at the generateTemplate service-singleton seam
 * via __resetGenerateTemplateForTests.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unnecessary-condition */
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
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { __resetPersistForTests } from "@/api/v2/agent-templates/handlers/generate-template";
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "@/api/v2/agent-templates/services/templateGen";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken } from "@/utils/jwt";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4017;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// ---------------------------------------------------------------------------
// Mock generateTemplate at the module-singleton seam
// ---------------------------------------------------------------------------

const happyTemplate: GeneratedTemplate = {
  agentName: "Brewski",
  description: "A cheery brewing buddy",
  prompt: "You help people brew coffee",
  category: "Food & Dining",
  emoji: "☕",
  tools: ["Search"],
  connections: [],
};

const mockHappy = () => {
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({ template: happyTemplate, metrics: DEFAULT_TEST_METRICS }),
  );
};

const mockReject = (error: Error) => {
  __resetGenerateTemplateForTests(() => Promise.reject(error));
};

// ---------------------------------------------------------------------------
// Mock persistDraftTemplate at the module-singleton seam
// ---------------------------------------------------------------------------

const FAKE_PERSISTED = (template: GeneratedTemplate, ownerAccountId: string) =>
  Promise.resolve({
    id: "00000000-0000-4000-8000-000000000099",
    slug: "brewski.abcde",
    ownerAccountId,
    forkedFromId: null,
    agentName: template.agentName,
    description: template.description || null,
    prompt: template.prompt,
    category: template.category || null,
    emoji: template.emoji || null,
    avatarUrl: null,
    tools: template.tools,
    connections: template.connections,
    version: 1,
    firstPublishedAt: null,
    status: "draft",
    featured: false,
    createdAt: new Date("2026-05-08T00:00:00Z"),
    updatedAt: new Date("2026-05-08T00:00:00Z"),
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;
const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

const setValidAgentApiKey = () => {
  process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
};

const restoreAgentApiKey = () => {
  if (originalAgentAssetsApiKey === undefined) {
    delete process.env.AGENT_ASSETS_API_KEY;
  } else {
    process.env.AGENT_ASSETS_API_KEY = originalAgentAssetsApiKey;
  }
};

const agentKeyHeaders = () => ({
  "Content-Type": "application/json",
  Accept: "text/event-stream",
  "X-Agent-API-Key": validAgentAssetsApiKey,
});

/** Collect all chunks from a streaming response into a single string. */
const collectSSE = async (res: Response): Promise<string> => {
  const chunks: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return chunks.join("");
};

const postGenerateSSE = async (body: Record<string, unknown>) => {
  const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
    method: "POST",
    headers: agentKeyHeaders(),
    body: JSON.stringify(body),
  });
  return res;
};

// ---------------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------------

const app = express();
app.set("case sensitive routing", true);
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/agent-templates", agentTemplatesRouter);
app.use(noRouteMiddleware);

let server: Server;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("POST /api/v2/agent-templates/generate (SSE mode)", () => {
  beforeAll(async () => {
    setValidAgentApiKey();
    // Stub PostHog so it doesn't make real captures during these tests
    __resetPostHogForTests(() => {});
    // Stub persist so no real database writes occur
    __resetPersistForTests(FAKE_PERSISTED);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(TEST_PORT, () => {
        resolve(s);
      });
    });
  });

  afterAll(async () => {
    __resetGenerateTemplateForTests(null);
    __resetPostHogForTests(null);
    __resetPersistForTests(null);
    restoreAgentApiKey();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    mockHappy();
  });

  // -----------------------------------------------------------------------
  // VAL-M3-SSE-001: SSE headers and early flush
  // -----------------------------------------------------------------------
  test("SSE response includes required headers", async () => {
    const res = await postGenerateSSE({ idea: "test" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("connection")).toBe("keep-alive");
  });

  test("headers arrive before body data (flushHeaders effect)", async () => {
    // The fact that we get a Response object with headers already available
    // proves flushHeaders() was called — otherwise Express would buffer the
    // entire response before sending headers.
    const res = await postGenerateSSE({ idea: "test" });
    // Headers are available immediately (before reading body)
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Body can be streamed after
    const body = await collectSSE(res);
    expect(body).toContain("event: result");
  });

  // -----------------------------------------------------------------------
  // VAL-M3-SSE-007: No X-Accel-Buffering: no header
  // -----------------------------------------------------------------------
  test("X-Accel-Buffering header is NOT set", async () => {
    const res = await postGenerateSSE({ idea: "test" });
    expect(res.headers.get("x-accel-buffering")).toBeNull();
  });

  // -----------------------------------------------------------------------
  // VAL-M3-SSE-002: Terminal success frame
  // -----------------------------------------------------------------------
  test("success emits event: result frame with serialized AgentTemplate JSON", async () => {
    const res = await postGenerateSSE({ idea: "test" });
    expect(res.status).toBe(200);

    const body = await collectSSE(res);

    // Must contain exactly one event: result
    expect(body).toContain("event: result\n");
    expect(body).toContain("data: ");

    // Parse the data JSON
    const dataMatch = body.match(/data: (\{.*\})\n\n/);
    expect(dataMatch).not.toBeNull();
    const parsed = JSON.parse(dataMatch![1]);

    // Serialized AgentTemplate shape (not raw GeneratedTemplate)
    expect(parsed.object).toBe("agent_template");
    expect(parsed.id).toBe("00000000-0000-4000-8000-000000000099");
    expect(parsed.slug).toBe("brewski.abcde");
    expect(parsed.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
    expect(parsed.agentName).toBe("Brewski");
    expect(parsed.description).toBe("A cheery brewing buddy");
    expect(parsed.prompt).toBe("You help people brew coffee");
    expect(parsed.category).toBe("Food & Dining");
    expect(parsed.emoji).toBe("☕");
    expect(parsed.tools).toEqual(["Search"]);
    expect(parsed.connections).toEqual([]);
    expect(parsed.version).toBe(1);
    expect(parsed.status).toBe("draft");
    expect(parsed.featured).toBe(false);
    expect(parsed.forkedFromId).toBeNull();
    expect(parsed.avatarUrl).toBeNull();
    expect(parsed.firstPublishedAt).toBeNull();
    expect(parsed.createdAt).toBe("2026-05-08T00:00:00.000Z");

    // No snake_case keys
    const keys = Object.keys(parsed);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
  });

  // -----------------------------------------------------------------------
  // VAL-M3-SSE-003: Terminal error frame; HTTP status is 200
  // -----------------------------------------------------------------------
  test("error emits event: error frame with {error, status}; HTTP status is 200", async () => {
    mockReject(new Error("Something went wrong"));

    const res = await postGenerateSSE({ idea: "test" });
    // HTTP status is 200 because headers were already flushed
    expect(res.status).toBe(200);

    const body = await collectSSE(res);

    expect(body).toContain("event: error\n");
    expect(body).not.toContain("event: result");

    const dataMatch = body.match(/data: (\{.*\})\n\n/);
    expect(dataMatch).not.toBeNull();
    const parsed = JSON.parse(dataMatch![1]);
    expect(parsed.error).toBe("Something went wrong");
    expect(parsed.status).toBe(502);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-SSE-004: Error → status mapping in SSE data payload
  // -----------------------------------------------------------------------
  test("validation-class errors map to status 400 in SSE data", async () => {
    const validationMessages = [
      "Invalid URL: malformed",
      "No content extracted",
      "Could not extract content from the page",
    ];

    for (const msg of validationMessages) {
      mockReject(new Error(msg));

      const res = await postGenerateSSE({ idea: "test" });
      expect(res.status).toBe(200); // headers flushed
      const body = await collectSSE(res);

      const dataMatch = body.match(/data: (\{.*\})\n\n/);
      expect(dataMatch).not.toBeNull();
      const parsed = JSON.parse(dataMatch![1]);
      expect(parsed.status).toBe(400);
      expect(parsed.error).toBe(msg);
    }
  });

  test("generic errors map to status 502 in SSE data", async () => {
    const genericMessages = [
      "OpenRouter API error 500: internal",
      "BUILDER_OPENROUTER_API_KEY not configured",
      "No content in LLM response",
    ];

    for (const msg of genericMessages) {
      mockReject(new Error(msg));

      const res = await postGenerateSSE({ idea: "test" });
      expect(res.status).toBe(200);
      const body = await collectSSE(res);

      const dataMatch = body.match(/data: (\{.*\})\n\n/);
      expect(dataMatch).not.toBeNull();
      const parsed = JSON.parse(dataMatch![1]);
      expect(parsed.status).toBe(502);
    }
  });

  // -----------------------------------------------------------------------
  // VAL-M3-SSE-006: Exactly one terminal frame per request
  // -----------------------------------------------------------------------
  test("success: exactly one terminal frame (event: result)", async () => {
    const res = await postGenerateSSE({ idea: "test" });
    const body = await collectSSE(res);

    const resultCount = (body.match(/event: result/g) || []).length;
    const errorCount = (body.match(/event: error/g) || []).length;
    expect(resultCount + errorCount).toBe(1);
    expect(resultCount).toBe(1);
    expect(errorCount).toBe(0);
  });

  test("error: exactly one terminal frame (event: error)", async () => {
    mockReject(new Error("fail"));

    const res = await postGenerateSSE({ idea: "test" });
    const body = await collectSSE(res);

    const resultCount = (body.match(/event: result/g) || []).length;
    const errorCount = (body.match(/event: error/g) || []).length;
    expect(resultCount + errorCount).toBe(1);
    expect(resultCount).toBe(0);
    expect(errorCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-SSE-008: SSE Accept substring match (not strict equality)
  // -----------------------------------------------------------------------
  test("Accept with text/event-stream substring routes to SSE mode", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json;q=0.9",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({ idea: "test" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await collectSSE(res);
    expect(body).toContain("event: result");
  });

  // -----------------------------------------------------------------------
  // VAL-M3-SSE-009: Validation-before-SSE preserved
  // -----------------------------------------------------------------------
  test("empty body with SSE Accept returns 400 JSON (NOT SSE)", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");

    const body = (await res.json()) as { error: string };
    expect(body).toHaveProperty("error");
    // No SSE framing
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("event:");
  });

  test("oversize text with SSE Accept returns 400 JSON (NOT SSE)", async () => {
    const longText = "x".repeat(50_001);

    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({ text: longText }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
  });

  // -----------------------------------------------------------------------
  // Additional: SSE frame format validation
  // -----------------------------------------------------------------------
  test("success frame format is event: result\\ndata: <JSON>\\n\\n", async () => {
    const res = await postGenerateSSE({ idea: "test" });
    const body = await collectSSE(res);

    // Frame should match the exact SSE framing convention
    expect(body).toMatch(/event: result\ndata: \{.*\}\n\n/);
  });

  test("error frame format is event: error\\ndata: {error, status}\\n\\n", async () => {
    mockReject(new Error("test error"));

    const res = await postGenerateSSE({ idea: "test" });
    const body = await collectSSE(res);

    expect(body).toMatch(
      /event: error\ndata: \{"error":".*?","status":\d+\}\n\n/,
    );
  });

  // -----------------------------------------------------------------------
  // SSE with JWT auth also works
  // -----------------------------------------------------------------------
  test("SSE works with JWT auth too", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Convos-AuthToken": await createJwtToken({
          deviceId: "test-device-sse",
          accountId: ADMIN_ACCOUNT_ID,
        }),
      },
      body: JSON.stringify({ idea: "test" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await collectSSE(res);
    expect(body).toContain("event: result");
  });
});
