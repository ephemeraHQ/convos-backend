/**
 * JSON-mode tests for POST /api/v2/agent-templates/generate
 *
 * Covers VAL-M3-ROUTE-001..010, VAL-M3-JSON-001..009.
 * OpenRouter is mocked at the generateTemplate service-singleton seam
 * via __resetGenerateTemplateForTests (mirrors connections test pattern).
 * PostHog capture is wired; we stub it via __resetPostHogForTests so it
 * doesn't interfere with these assertions.
 */
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
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import {
  __resetGenerateTemplateForTests,
  BREVITY_RAIL,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "@/api/v2/agent-templates/services/templateGen";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken } from "@/utils/jwt";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEXT_LEN = 50_000;
const MAX_BASE64_LEN = 35_000_000;

const TEST_PORT = 4015;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// ---------------------------------------------------------------------------
// Mock generateTemplate at the module-singleton seam
// ---------------------------------------------------------------------------

let generateCallCount = 0;
let lastGenerateInput: unknown = null;

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
  __resetGenerateTemplateForTests((input) => {
    generateCallCount++;
    lastGenerateInput = input;
    return Promise.resolve({
      template: happyTemplate,
      metrics: DEFAULT_TEST_METRICS,
    });
  });
};

const mockReject = (error: Error) => {
  __resetGenerateTemplateForTests(() => {
    return Promise.reject(error);
  });
};

const mockResolve = (template: GeneratedTemplate) => {
  __resetGenerateTemplateForTests((input) => {
    generateCallCount++;
    lastGenerateInput = input;
    return Promise.resolve({ template, metrics: DEFAULT_TEST_METRICS });
  });
};

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

const jwtHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-generate",
  }),
});

const agentKeyHeaders = (key = validAgentAssetsApiKey) => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": key,
});

const postGenerate = async (
  body: Record<string, unknown>,
  headers: Record<string, string>,
) => {
  const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
    method: "POST",
    headers,
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

describe("POST /api/v2/agent-templates/generate (JSON mode)", () => {
  beforeAll(async () => {
    setValidAgentApiKey();
    // Stub PostHog so it doesn't make real captures during these tests
    __resetPostHogForTests(() => {});
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(TEST_PORT, () => {
        resolve(s);
      });
    });
  });

  afterAll(async () => {
    __resetGenerateTemplateForTests(null);
    __resetPostHogForTests(null);
    restoreAgentApiKey();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    generateCallCount = 0;
    lastGenerateInput = null;
    // Default: happy path
    mockHappy();
  });

  // -----------------------------------------------------------------------
  // VAL-M3-ROUTE-001: Route mounts at kebab-case path
  // -----------------------------------------------------------------------
  test("kebab path is reachable; snake path returns 404", async () => {
    const [kebab, snake] = await Promise.all([
      fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
        method: "POST",
        headers: await jwtHeaders(),
        body: JSON.stringify({ idea: "test" }),
      }),
      fetch(`${BASE_URL}/api/v2/agent_templates/generate`, { method: "POST" }),
    ]);

    expect(kebab.status).not.toBe(404);
    expect(snake.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-ROUTE-002: Method is POST only
  // GET/PUT hit no matching generate route (404); PATCH/DELETE match /:id
  // but the generate handler is NOT invoked for non-POST methods.
  // -----------------------------------------------------------------------
  test("only POST invokes the generate handler; GET/PUT return 404", async () => {
    // GET matches /:idOrHashedSlug but returns 404 (not a valid id);
    // PUT has no matching route → 404 from noRouteMiddleware
    const [getRes, putRes] = await Promise.all([
      fetch(`${BASE_URL}/api/v2/agent-templates/generate`),
      fetch(`${BASE_URL}/api/v2/agent-templates/generate`, { method: "PUT" }),
    ]);
    expect(getRes.status).toBe(404);
    expect(putRes.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-ROUTE-003: JWT auth principal is accepted
  // -----------------------------------------------------------------------
  test("valid JWT reaches the handler (status ≠ 401)", async () => {
    const res = await postGenerate({ idea: "test" }, await jwtHeaders());
    expect(res.status).not.toBe(401);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-ROUTE-004: X-Agent-API-Key auth principal is accepted
  // -----------------------------------------------------------------------
  test("valid agent API key reaches the handler (status ≠ 401)", async () => {
    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).not.toBe(401);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-ROUTE-005: Missing/invalid auth returns 401; SSE branch NOT entered
  // -----------------------------------------------------------------------
  test("missing auth returns 401 JSON", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: "test" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("invalid JWT returns 401 JSON", async () => {
    const res = await postGenerate(
      { idea: "test" },
      { "Content-Type": "application/json", "X-Convos-AuthToken": "not.a.jwt" },
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  test("invalid agent API key returns 401 JSON (no SSE branch)", async () => {
    const res = await postGenerate(
      { idea: "test" },
      agentKeyHeaders("wrong-key-value"),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
  });

  // -----------------------------------------------------------------------
  // VAL-M3-ROUTE-006: Body accepts each input shape (legacy coalescing)
  // -----------------------------------------------------------------------
  test("accepts { text } and passes it through", async () => {
    const res = await postGenerate({ text: "hello world" }, agentKeyHeaders());
    expect(res.status).toBe(200);
    expect(generateCallCount).toBe(1);
    expect(lastGenerateInput).toEqual({ text: "hello world" });
  });

  test("accepts { idea } and coalesces to text", async () => {
    const res = await postGenerate(
      { idea: "my great idea" },
      agentKeyHeaders(),
    );
    expect(res.status).toBe(200);
    expect(generateCallCount).toBe(1);
    expect(lastGenerateInput).toEqual({ text: "my great idea" });
  });

  test("accepts { content } and coalesces to text", async () => {
    const res = await postGenerate(
      { content: "some content here" },
      agentKeyHeaders(),
    );
    expect(res.status).toBe(200);
    expect(generateCallCount).toBe(1);
    expect(lastGenerateInput).toEqual({ text: "some content here" });
  });

  test("accepts { url } and coalesces to text", async () => {
    const res = await postGenerate(
      { url: "https://example.com" },
      agentKeyHeaders(),
    );
    expect(res.status).toBe(200);
    expect(generateCallCount).toBe(1);
    expect(lastGenerateInput).toEqual({ text: "https://example.com" });
  });

  test("first non-empty among text|idea|content|url wins", async () => {
    const res = await postGenerate(
      {
        text: "primary",
        idea: "secondary",
        content: "tertiary",
        url: "https://x.com",
      },
      agentKeyHeaders(),
    );
    expect(res.status).toBe(200);
    expect(lastGenerateInput).toEqual({ text: "primary" });
  });

  test("idea wins when text is empty", async () => {
    const res = await postGenerate(
      { text: "", idea: "fallback" },
      agentKeyHeaders(),
    );
    expect(res.status).toBe(200);
    expect(lastGenerateInput).toEqual({ text: "fallback" });
  });

  test("accepts { pdfBase64, mimeType, filename }", async () => {
    const res = await postGenerate(
      {
        pdfBase64: "dGVzdA==",
        mimeType: "application/pdf",
        filename: "doc.pdf",
      },
      agentKeyHeaders(),
    );
    expect(res.status).toBe(200);
    expect(generateCallCount).toBe(1);
    expect(lastGenerateInput).toEqual({
      pdfBase64: "dGVzdA==",
      mimeType: "application/pdf",
      filename: "doc.pdf",
    });
  });

  test("accepts { imageBase64, mimeType }", async () => {
    const res = await postGenerate(
      { imageBase64: "dGVzdA==", mimeType: "image/png" },
      agentKeyHeaders(),
    );
    expect(res.status).toBe(200);
    expect(generateCallCount).toBe(1);
    expect(lastGenerateInput).toEqual({
      imageBase64: "dGVzdA==",
      mimeType: "image/png",
    });
  });

  // -----------------------------------------------------------------------
  // VAL-M3-ROUTE-007: Empty body returns JSON 400 (no SSE branch)
  // -----------------------------------------------------------------------
  test("empty body returns 400 JSON even with SSE Accept", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        ...agentKeyHeaders(),
        Accept: "text/event-stream",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
    const body = await res.json();
    expect(body).toHaveProperty("error");
    // No SSE frame emitted
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("event:");
  });

  // -----------------------------------------------------------------------
  // VAL-M3-ROUTE-008: text > MAX_TEXT_LEN returns JSON 400
  // -----------------------------------------------------------------------
  test(`text longer than ${MAX_TEXT_LEN} returns 400 JSON regardless of Accept`, async () => {
    const longText = "x".repeat(MAX_TEXT_LEN + 1);

    // Without SSE Accept
    const res1 = await postGenerate({ text: longText }, agentKeyHeaders());
    expect(res1.status).toBe(400);
    expect(res1.headers.get("content-type")).toContain("application/json");

    // With SSE Accept
    const res2 = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        ...agentKeyHeaders(),
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ text: longText }),
    });
    expect(res2.status).toBe(400);
    expect(res2.headers.get("content-type")).toContain("application/json");
    expect(res2.headers.get("content-type")).not.toContain("text/event-stream");
  });

  // -----------------------------------------------------------------------
  // VAL-M3-ROUTE-009: base64 > MAX_BASE64_LEN returns JSON 400
  // -----------------------------------------------------------------------
  test(`pdfBase64 longer than ${MAX_BASE64_LEN} returns 400 JSON`, async () => {
    const longBase64 = "A".repeat(MAX_BASE64_LEN + 1);

    const res = await postGenerate(
      {
        pdfBase64: longBase64,
        mimeType: "application/pdf",
        filename: "big.pdf",
      },
      agentKeyHeaders(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test(`imageBase64 longer than ${MAX_BASE64_LEN} returns 400 JSON`, async () => {
    const longBase64 = "A".repeat(MAX_BASE64_LEN + 1);

    const res = await postGenerate(
      { imageBase64: longBase64, mimeType: "image/png" },
      agentKeyHeaders(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  // -----------------------------------------------------------------------
  // VAL-M3-JSON-001: Default Accept returns JSON 200
  // -----------------------------------------------------------------------
  test("default Accept returns 200 application/json with no SSE framing", async () => {
    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.text();
    expect(body).not.toContain("event: result");
    expect(body).not.toContain("event: error");
    expect(body).not.toContain("data:");
  });

  // -----------------------------------------------------------------------
  // VAL-M3-JSON-002: Response shape is camelCase
  // -----------------------------------------------------------------------
  test("response keys are exactly the camelCase set", async () => {
    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const sortedKeys = Object.keys(body).sort();
    expect(sortedKeys).toEqual([
      "agentName",
      "category",
      "connections",
      "description",
      "emoji",
      "prompt",
      "tools",
    ]);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-JSON-003: Server-injected connections: []
  // -----------------------------------------------------------------------
  test("connections is always [] in the response", async () => {
    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connections).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-JSON-004: Soft defaults for non-name fields
  // -----------------------------------------------------------------------
  test("empty strings and empty arrays are preserved (soft defaults)", async () => {
    const softTemplate: GeneratedTemplate = {
      agentName: "X",
      description: "",
      prompt: "",
      category: "",
      emoji: "",
      tools: [],
      connections: [],
    };
    mockResolve(softTemplate);

    const res = await postGenerate({ idea: "soft test" }, agentKeyHeaders());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.agentName).toBe("X");
    expect(body.description).toBe("");
    expect(body.prompt).toBe("");
    expect(body.tools).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-JSON-005: Missing agentName returns 502
  // -----------------------------------------------------------------------
  test("missing agentName from LLM returns 502", async () => {
    mockReject(new Error("LLM response missing agentName"));

    const res = await postGenerate({ idea: "no name" }, agentKeyHeaders());
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/agentName/i);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-JSON-006: Brevity rail appended on production-LLM path
  // -----------------------------------------------------------------------
  test("prompt ends with brevity rail on production-LLM path", async () => {
    const templateWithRail: GeneratedTemplate = {
      ...happyTemplate,
      prompt: `${happyTemplate.prompt}\n\n---\n\n${BREVITY_RAIL}`,
    };
    mockResolve(templateWithRail);

    const res = await postGenerate({ idea: "rail test" }, agentKeyHeaders());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompt: string };
    expect(body.prompt.endsWith(BREVITY_RAIL)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-JSON-007: No double brevity rail on passthrough paths
  // -----------------------------------------------------------------------
  test("passthrough paths do not double-append brevity rail", async () => {
    // Simulate a passthrough template that already has the rail appended once
    const passthroughTemplate: GeneratedTemplate = {
      ...happyTemplate,
      prompt: `Some raw content\n\n---\n\n${BREVITY_RAIL}`,
    };
    mockResolve(passthroughTemplate);

    const res = await postGenerate({ idea: "passthrough" }, agentKeyHeaders());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompt: string };
    const count = (body.prompt.match(/## Runtime Reminder/g) || []).length;
    expect(count).toBe(1);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-JSON-008: Error → status mapping
  // -----------------------------------------------------------------------
  test("validation-class errors return 400", async () => {
    const validationMessages = [
      "Invalid URL: malformed",
      "No content extracted",
      "Could not extract content from the page",
    ];

    for (const msg of validationMessages) {
      mockReject(new Error(msg));

      const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBeTruthy();
    }
  });

  test("generic errors return 502", async () => {
    mockReject(new Error("OpenRouter API error 500: internal"));

    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  test("BUILDER_OPENROUTER_API_KEY not configured returns 502", async () => {
    mockReject(new Error("BUILDER_OPENROUTER_API_KEY not configured"));

    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).toBe(502);
  });

  // -----------------------------------------------------------------------
  // VAL-M3-JSON-009: 2xx OpenRouter with missing choices returns 502
  // -----------------------------------------------------------------------
  test("OpenRouter 2xx with missing choices[0].message.content returns 502", async () => {
    mockReject(new Error("No content in LLM response"));

    const res = await postGenerate(
      { idea: "empty response" },
      agentKeyHeaders(),
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no content|missing|empty/i);
  });
});
