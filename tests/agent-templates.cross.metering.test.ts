/**
 * Cross-area metering test for POST /api/v2/agent-templates/generate
 *
 * Covers VAL-CROSS-METERING-001:
 *   Each /generate success emits exactly one PostHog event with
 *   auth-mode-specific tag. Crosses M3 (generate handler) + auth
 *   middleware + PostHog wrapper.
 *
 * Three cases:
 *   1. JWT success → exactly one capture, authMode='jwt'
 *   2. AgentKey success → exactly one capture, authMode='agentKey'
 *   3. Validation error (empty body) → zero captures
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
import {
  __resetPostHogForTests,
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

const TEST_PORT = 4071;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const happyTemplate: GeneratedTemplate = {
  agentName: "CrossMeterBot",
  description: "Cross-area metering test assistant",
  prompt: "You test metering",
  category: "Work",
  emoji: "📊",
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

describe("Cross-area metering: auth mode + PostHog (VAL-CROSS-METERING-001)", () => {
  beforeAll(async () => {
    setValidAgentApiKey();
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
    stubPostHog();
    __resetGenerateTemplateForTests(() =>
      Promise.resolve({
        template: happyTemplate,
        metrics: DEFAULT_TEST_METRICS,
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Case 1: JWT success → exactly one capture with authMode='jwt'
  // -----------------------------------------------------------------------
  test("jwt-success: one capture, authMode='jwt'", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Convos-AuthToken": await createJwtToken({
          deviceId: "test-cross-meter-jwt",
          accountId: ADMIN_ACCOUNT_ID,
        }),
      },
      body: JSON.stringify({ idea: "jwt test" }),
    });

    expect(res.status).toBe(200);
    expect(capturedPostHog.length).toBe(1);

    const props = capturedPostHog[0];
    expect(props.authMode).toBe("jwt");
    expect(props.model).toBe(DEFAULT_TEST_METRICS.model);
    expect(props.promptTokens).toBe(DEFAULT_TEST_METRICS.promptTokens);
    expect(props.completionTokens).toBe(DEFAULT_TEST_METRICS.completionTokens);
    expect(typeof props.latencyMs).toBe("number");
    expect(UUID_V4_RE.test(props.requestId)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Case 2: AgentKey success → exactly one capture with authMode='agentKey'
  // -----------------------------------------------------------------------
  test("agentKey-success: one capture, authMode='agentKey'", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({ idea: "agent key test" }),
    });

    expect(res.status).toBe(200);
    expect(capturedPostHog.length).toBe(1);

    const props = capturedPostHog[0];
    expect(props.authMode).toBe("agentKey");
    expect(props.model).toBe(DEFAULT_TEST_METRICS.model);
    expect(props.promptTokens).toBe(DEFAULT_TEST_METRICS.promptTokens);
    expect(props.completionTokens).toBe(DEFAULT_TEST_METRICS.completionTokens);
    expect(typeof props.latencyMs).toBe("number");
    expect(UUID_V4_RE.test(props.requestId)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Case 3: Validation error (empty body) → zero captures
  // -----------------------------------------------------------------------
  test("validation-error-no-event: empty body → 400, zero PostHog events", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(capturedPostHog.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Property naming consistency across both auth modes
  // -----------------------------------------------------------------------
  test("property naming is consistent across jwt and agentKey", async () => {
    // JWT request
    await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Convos-AuthToken": await createJwtToken({
          deviceId: "test-cross-consistency",
          accountId: ADMIN_ACCOUNT_ID,
        }),
      },
      body: JSON.stringify({ idea: "consistency jwt" }),
    });

    // Agent key request
    await fetch(`${BASE_URL}/api/v2/agent-templates/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-API-Key": validAgentAssetsApiKey,
      },
      body: JSON.stringify({ idea: "consistency agent" }),
    });

    expect(capturedPostHog.length).toBe(2);

    const jwtKeys = Object.keys(capturedPostHog[0]).sort();
    const agentKeys = Object.keys(capturedPostHog[1]).sort();
    expect(jwtKeys).toEqual(agentKeys);
  });
});
