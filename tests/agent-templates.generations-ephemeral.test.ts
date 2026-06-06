/**
 * Tests for POST /api/v2/agent-templates/generations/ephemeral
 *
 * Covers:
 *   - Auth: non-API-key caller                                  → 403
 *   - Validation: missing/empty inputs                          → 400
 *   - Happy path: returns { template } inline, builderPrompt
 *     forwarded, and NOTHING persisted                          → 200
 *   - Generator error: stable generic message (no leak)         → 500
 *   - Timeout: AbortSignal fires                                → 504
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { __setEphemeralTimeoutMsForTests } from "@/api/v2/agent-templates/handlers/generations-ephemeral-post";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
} from "@/api/v2/agent-templates/services/templateGen";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import { prisma } from "@/utils/prisma";
import {
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";
import { makeFakeTemplate } from "./agent-templates.generation.helpers";

const TEST_PORT = 4079;
const fakeTemplate = makeFakeTemplate({
  agentName: "Ephemeral Test Agent",
  description: "desc",
  prompt: "prompt",
});

const apiKeyHeaders = {
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
};
const noKeyHeaders = { "Content-Type": "application/json" };

// Records the args the generator was called with, so a test can assert the
// builderPrompt override is forwarded (the 5th param, systemPromptOverride).
let lastCall: { systemPromptOverride?: string | null } | null = null;

let baseURL: string;
let closeServer: () => Promise<void>;

const post = (body: unknown, headers: Record<string, string> = apiKeyHeaders) =>
  fetch(`${baseURL}/api/v2/agent-templates/generations/ephemeral`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
  const server = await startAgentTemplatesServer(TEST_PORT);
  baseURL = server.baseURL;
  closeServer = server.close;
});

beforeEach(() => {
  lastCall = null;
  __setEphemeralTimeoutMsForTests(null);
  // Default: a fast, successful generation that records its override arg.
  __resetGenerateTemplateForTests(
    (_input, _signal, _prefill, _trace, systemPromptOverride) => {
      lastCall = { systemPromptOverride };
      return Promise.resolve({
        template: fakeTemplate,
        metrics: DEFAULT_TEST_METRICS,
      });
    },
  );
});

afterEach(() => {
  __setEphemeralTimeoutMsForTests(null);
});

afterAll(async () => {
  __resetGenerateTemplateForTests(null);
  __setAgentAssetsApiKeyOverrideForTests(undefined);
  await closeServer();
});

describe("POST /generations/ephemeral — auth", () => {
  test("no agent API key → 403", async () => {
    const res = await post(
      { inputs: { idea: "a wine club sommelier" } },
      noKeyHeaders,
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /generations/ephemeral — validation", () => {
  test("missing inputs → 400", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });

  test("empty inputs (no usable input) → 400", async () => {
    const res = await post({ inputs: {} });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("one of");
  });
});

describe("POST /generations/ephemeral — happy path", () => {
  test("returns the template inline, forwards builderPrompt, persists nothing", async () => {
    const before = await prisma.agentTemplate.count({
      where: { agentName: fakeTemplate.agentName },
    });

    const res = await post({
      inputs: { idea: "a wine club sommelier" },
      builderPrompt: "CUSTOM BUILDER PROMPT",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: { agentName: string } };
    expect(body.template.agentName).toBe(fakeTemplate.agentName);

    // The override (builderPrompt) reaches the generator as systemPromptOverride.
    expect(lastCall?.systemPromptOverride).toBe("CUSTOM BUILDER PROMPT");

    // Ephemeral: no AgentTemplate row created.
    const after = await prisma.agentTemplate.count({
      where: { agentName: fakeTemplate.agentName },
    });
    expect(after).toBe(before);
  });
});

describe("POST /generations/ephemeral — error mapping", () => {
  test("generator failure → 500 with a stable generic message (no leak)", async () => {
    __resetGenerateTemplateForTests(() =>
      Promise.reject(new Error("boom: internal secret detail")),
    );
    const res = await post({ inputs: { idea: "x" } });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Generation failed");
    expect(body.error).not.toContain("secret");
  });

  test("timeout → 504", async () => {
    __setEphemeralTimeoutMsForTests(20);
    // Reject when the timeout signal aborts (mirrors a real aborted fetch).
    __resetGenerateTemplateForTests(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const res = await post({ inputs: { idea: "x" } });
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("timed out");
  });
});
