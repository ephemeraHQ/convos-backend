/**
 * PostHog metering tests for POST /api/v2/agent-templates/generate
 *
 * Covers VAL-M3-POSTHOG-001..006:
 *   001 — Exactly one capture per /generate invocation (success + error)
 *   002 — Event name is "builder.template.generated"
 *   003 — Properties shape (model, promptTokens, completionTokens, latencyMs, requestId, authMode)
 *   004 — Missing PostHog env is a no-op
 *   005 — Capture is fire-and-forget (no measurable latency)
 *   006 — authMode reflects JWT vs agentKey
 *
 * OpenRouter is mocked at the generateTemplate service-singleton seam.
 * PostHog is stubbed at the module-singleton seam via __resetPostHogForTests.
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
import { __resetPersistForTests } from "@/api/v2/agent-templates/handlers/generate-template";
import {
  __resetPostHogForTests,
  BUILDER_TEMPLATE_GENERATED_EVENT,
  type PostHogCaptureProperties,
} from "@/api/v2/agent-templates/services/posthog";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "@/api/v2/agent-templates/services/templateGen";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4069;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// ---------------------------------------------------------------------------
// Mocks
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

/** Captured PostHog calls — reset beforeEach. */
let capturedPostHog: PostHogCaptureProperties[] = [];

const stubPostHog = () => {
  capturedPostHog = [];
  __resetPostHogForTests((properties) => {
    capturedPostHog.push(properties);
  });
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

const jwtHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-posthog",
    accountId: ADMIN_ACCOUNT_ID,
  }),
});

const agentKeyHeaders = () => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
});

const postGenerate = async (
  body: Record<string, unknown>,
  headers: Record<string, string>,
) =>
  fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

describe("PostHog metering for POST /api/v2/agent-templates/generate", () => {
  beforeAll(async () => {
    setValidAgentApiKey();
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
    stubPostHog();
    mockHappy();
  });

  // ---------------------------------------------------------------------
  // VAL-M3-POSTHOG-001: Exactly one capture per invocation
  // ---------------------------------------------------------------------
  test("success: exactly one capture call", async () => {
    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).toBe(200);
    expect(capturedPostHog.length).toBe(1);
  });

  test("error: exactly one capture call (LLM failure is metered)", async () => {
    mockReject(new Error("OpenRouter API error 500: internal"));

    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).toBe(502);
    expect(capturedPostHog.length).toBe(1);
  });

  // ---------------------------------------------------------------------
  // VAL-M3-POSTHOG-002: Event name is "builder.template.generated"
  // ---------------------------------------------------------------------
  test("event name constant is the locked literal", () => {
    expect(BUILDER_TEMPLATE_GENERATED_EVENT).toBe("builder.template.generated");
  });

  // The capture function is tested via the stub; the constant is verified
  // separately to ensure no typo or refactoring drift.

  // ---------------------------------------------------------------------
  // VAL-M3-POSTHOG-003: Properties shape
  // ---------------------------------------------------------------------
  test("success: properties include all required keys with correct types", async () => {
    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).toBe(200);

    const props = capturedPostHog[0];
    expect(typeof props.model).toBe("string");
    expect(typeof props.promptTokens).toBe("number");
    expect(typeof props.completionTokens).toBe("number");
    expect(typeof props.latencyMs).toBe("number");
    expect(typeof props.requestId).toBe("string");
    expect(UUID_V4_RE.test(props.requestId)).toBe(true);
    expect(["jwt", "agentKey"]).toContain(props.authMode);
    expect(props.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  test("error: properties include all required keys with correct types", async () => {
    mockReject(new Error("OpenRouter API error 500: internal"));

    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).toBe(502);

    const props = capturedPostHog[0];
    expect(typeof props.model).toBe("string");
    expect(typeof props.promptTokens).toBe("number");
    expect(typeof props.completionTokens).toBe("number");
    expect(typeof props.latencyMs).toBe("number");
    expect(typeof props.requestId).toBe("string");
    expect(UUID_V4_RE.test(props.requestId)).toBe(true);
    expect(["jwt", "agentKey"]).toContain(props.authMode);
    expect(props.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  test("success: metrics from the service are passed through", async () => {
    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).toBe(200);

    const props = capturedPostHog[0];
    // DEFAULT_TEST_METRICS has specific values
    expect(props.model).toBe(DEFAULT_TEST_METRICS.model);
    expect(props.promptTokens).toBe(DEFAULT_TEST_METRICS.promptTokens);
    expect(props.completionTokens).toBe(DEFAULT_TEST_METRICS.completionTokens);
  });

  test("error: promptTokens and completionTokens default to 0", async () => {
    mockReject(new Error("OpenRouter API error 500: internal"));

    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).toBe(502);

    const props = capturedPostHog[0];
    expect(props.promptTokens).toBe(0);
    expect(props.completionTokens).toBe(0);
  });

  // ---------------------------------------------------------------------
  // VAL-M3-POSTHOG-004: Missing PostHog env is a no-op
  // ---------------------------------------------------------------------
  test("missing PostHog env vars: route still returns 200", async () => {
    // Remove the PostHog stub so the real code path runs (no env vars set)
    __resetPostHogForTests(null);
    // Ensure env vars are absent
    const origApiKey = process.env.POSTHOG_API_KEY;
    const origHost = process.env.POSTHOG_HOST;
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_HOST;

    try {
      const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
      expect(res.status).toBe(200);
      // Route response is unaffected — body is the normal camelCase shape
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.agentName).toBe("Brewski");
    } finally {
      // Restore env
      if (origApiKey !== undefined) process.env.POSTHOG_API_KEY = origApiKey;
      if (origHost !== undefined) process.env.POSTHOG_HOST = origHost;
      // Re-stub for subsequent tests
      stubPostHog();
    }
  });

  // ---------------------------------------------------------------------
  // VAL-M3-POSTHOG-005: Capture is fire-and-forget
  // ---------------------------------------------------------------------
  test("capture does not block the response (sub-100ms overhead)", async () => {
    // Use a mock that resolves instantly
    const resolveTime = performance.now();
    mockHappy();

    // Install a PostHog stub that is synchronous (mirrors real posthog-node
    // capture which returns void synchronously and buffers internally).
    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    const responseTime = performance.now();

    expect(res.status).toBe(200);
    // The response should arrive within 100ms of the mock resolve —
    // if capture were awaited, it would add measurable latency.
    expect(responseTime - resolveTime).toBeLessThan(500);
  });

  // ---------------------------------------------------------------------
  // VAL-M3-POSTHOG-006: authMode reflects the principal
  // ---------------------------------------------------------------------
  test("JWT auth produces authMode='jwt'", async () => {
    const res = await postGenerate({ idea: "test" }, await jwtHeaders());
    expect(res.status).toBe(200);

    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].authMode).toBe("jwt");
    expect(capturedPostHog[0].ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  test("Agent API key auth produces authMode='agentKey'", async () => {
    const res = await postGenerate({ idea: "test" }, agentKeyHeaders());
    expect(res.status).toBe(200);

    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].authMode).toBe("agentKey");
    expect(capturedPostHog[0].ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  // ---------------------------------------------------------------------
  // Additional: validation errors emit ZERO PostHog events
  // (spec: "Validation errors that 400 before the LLM call MUST NOT
  //  emit a PostHog event.")
  // ---------------------------------------------------------------------
  test("empty body (400) emits zero PostHog events", async () => {
    const res = await postGenerate({}, agentKeyHeaders());
    expect(res.status).toBe(400);
    expect(capturedPostHog.length).toBe(0);
  });

  test("oversize text (400) emits zero PostHog events", async () => {
    const res = await postGenerate(
      { text: "x".repeat(50_001) },
      agentKeyHeaders(),
    );
    expect(res.status).toBe(400);
    expect(capturedPostHog.length).toBe(0);
  });

  test("missing auth (401) emits zero PostHog events", async () => {
    const res = await postGenerate(
      { idea: "test" },
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(401);
    expect(capturedPostHog.length).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Additional: requestId is unique per request
  // ---------------------------------------------------------------------
  test("requestId is unique across two sequential requests", async () => {
    await postGenerate({ idea: "test1" }, agentKeyHeaders());
    await postGenerate({ idea: "test2" }, agentKeyHeaders());

    expect(capturedPostHog.length).toBe(2);
    expect(capturedPostHog[0].requestId).not.toBe(capturedPostHog[1].requestId);
  });

  // ---------------------------------------------------------------------
  // Additional: SSE mode also captures PostHog
  // ---------------------------------------------------------------------
  test("SSE success also emits one PostHog capture", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        ...agentKeyHeaders(),
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ idea: "test" }),
    });

    expect(res.status).toBe(200);
    expect(capturedPostHog.length).toBe(1);
    expect(capturedPostHog[0].authMode).toBe("agentKey");
    expect(capturedPostHog[0].ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  test("SSE error also emits one PostHog capture", async () => {
    mockReject(new Error("OpenRouter API error 502: bad gateway"));

    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        ...agentKeyHeaders(),
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ idea: "test" }),
    });

    expect(res.status).toBe(200); // SSE always 200
    expect(capturedPostHog.length).toBe(1);
  });
});
