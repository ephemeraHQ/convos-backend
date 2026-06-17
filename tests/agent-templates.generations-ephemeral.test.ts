/**
 * Tests for POST /api/v2/agent-templates/generations/ephemeral
 *
 * Covers:
 *   - Auth: non-API-key caller                                  → 403
 *   - Validation: missing/empty inputs                          → 400
 *   - Happy path: returns { template } inline, builderPrompt
 *     forwarded, and NOTHING persisted                          → 200
 *   - builderModel: valid id forwarded as the model override     → 200
 *   - builderModel: unknown to OpenRouter's catalog              → 400
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
import { __setSseKeepaliveMsForTests } from "@/api/v2/agent-templates/lib/sse";
import { __setOpenRouterModelsForTests } from "@/api/v2/agent-templates/services/openrouter-models";
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
const sseApiKeyHeaders = {
  ...apiKeyHeaders,
  Accept: "text/event-stream",
};
const noKeyHeaders = { "Content-Type": "application/json" };

// Records the args the generator was called with, so a test can assert the
// overrides are forwarded: builderPrompt as the 5th param (systemPromptOverride),
// builderModel as the 6th (modelOverride), and connections as the 7th.
let lastCall: {
  systemPromptOverride?: string | null;
  modelOverride?: string | null;
  connections?: string[] | null;
} | null = null;

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
  // Fixed model catalog so builderModel validation is hermetic (no network).
  __setOpenRouterModelsForTests([
    "anthropic/claude-opus-4.8",
    "anthropic/claude-opus-4.7",
  ]);
  const server = await startAgentTemplatesServer(TEST_PORT);
  baseURL = server.baseURL;
  closeServer = server.close;
});

beforeEach(() => {
  lastCall = null;
  __setEphemeralTimeoutMsForTests(null);
  // Default: a fast, successful generation that records its override args.
  __resetGenerateTemplateForTests(
    (
      _input,
      _signal,
      _prefill,
      _trace,
      systemPromptOverride,
      modelOverride,
      connections,
    ) => {
      lastCall = { systemPromptOverride, modelOverride, connections };
      return Promise.resolve({
        template: fakeTemplate,
        metrics: DEFAULT_TEST_METRICS,
      });
    },
  );
});

afterEach(() => {
  __setEphemeralTimeoutMsForTests(null);
  __setSseKeepaliveMsForTests(null);
});

afterAll(async () => {
  __resetGenerateTemplateForTests(null);
  __setOpenRouterModelsForTests(null);
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
    expect(body.error.toLowerCase()).toContain("attachment");
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

describe("POST /generations/ephemeral — builderModel (privileged override)", () => {
  test("valid id is forwarded to the generator as the model override", async () => {
    const res = await post({
      inputs: { idea: "a wine club sommelier" },
      builderModel: "anthropic/claude-opus-4.8",
    });
    expect(res.status).toBe(200);
    // The override reaches the generator as the 6th param (modelOverride).
    expect(lastCall?.modelOverride).toBe("anthropic/claude-opus-4.8");
  });

  test("unknown id (not in OpenRouter's catalog) → 400", async () => {
    const res = await post({
      inputs: { idea: "x" },
      builderModel: "anthropic/claude-opus-9.9-imaginary",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("is not a valid OpenRouter model");
  });
});

describe("POST /generations/ephemeral — connections", () => {
  test("unknown connection → 400", async () => {
    const res = await post({
      inputs: { idea: "x" },
      connections: ["not_a_real_service"],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unknown connection");
  });

  test("valid connections are forwarded to the generator and overlaid onto the returned template", async () => {
    const res = await post({
      inputs: { idea: "a scheduling helper" },
      // Mixed case + duplicate to exercise catalog normalization + dedupe.
      connections: ["GoogleCalendar", "googlecalendar"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      template: { connections: string[] };
    };
    // Normalized canonical id forwarded to the generator (7th param)...
    expect(lastCall?.connections).toEqual(["googlecalendar"]);
    // ...and overlaid onto the returned (non-persisted) template.
    expect(body.template.connections).toEqual(["googlecalendar"]);
  });

  test("no connections → generator gets [] and template stays empty", async () => {
    const res = await post({ inputs: { idea: "a scheduling helper" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      template: { connections: string[] };
    };
    expect(lastCall?.connections).toEqual([]);
    expect(body.template.connections).toEqual([]);
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

describe("POST /generations/ephemeral — SSE mode", () => {
  test("emits `event: result` carrying the template, forwards builderPrompt", async () => {
    const res = await post(
      {
        inputs: { idea: "a wine club sommelier" },
        builderPrompt: "CUSTOM BUILDER PROMPT",
      },
      sseApiKeyHeaders,
    );

    // HTTP status is always 200 in SSE mode; the payload rides in the frame.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: result");
    expect(text).not.toContain("event: error");
    expect(text).toContain(fakeTemplate.agentName);
    expect(text).toContain('"metrics":');

    // The override still reaches the generator on the streaming path.
    expect(lastCall?.systemPromptOverride).toBe("CUSTOM BUILDER PROMPT");
  });

  test("emits `event: error` on generator failure (no leak)", async () => {
    __resetGenerateTemplateForTests(() =>
      Promise.reject(new Error("boom: internal secret detail")),
    );
    const res = await post({ inputs: { idea: "x" } }, sseApiKeyHeaders);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: result");
    expect(text).toContain("Generation failed");
    expect(text).not.toContain("secret");
  });

  test("emits `event: error` on timeout", async () => {
    __setEphemeralTimeoutMsForTests(20);
    __resetGenerateTemplateForTests(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const res = await post({ inputs: { idea: "x" } }, sseApiKeyHeaders);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text.toLowerCase()).toContain("timed out");
  });

  test("emits keep-alive frames before the terminal result", async () => {
    // Slow the generation so the keep-alive interval fires before it resolves.
    __resetGenerateTemplateForTests(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ template: fakeTemplate, metrics: DEFAULT_TEST_METRICS });
          }, 300);
        }),
    );
    __setSseKeepaliveMsForTests(50);

    const res = await post({ inputs: { idea: "x" } }, sseApiKeyHeaders);
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).toContain(":\n\n");
    expect(text).toContain("event: result");

    // Keep-alive comment frames must precede the terminal frame.
    const keepaliveIdx = text.indexOf(":\n\n");
    const resultIdx = text.indexOf("event: result");
    expect(keepaliveIdx).toBeGreaterThanOrEqual(0);
    expect(keepaliveIdx).toBeLessThan(resultIdx);
  });

  test("client disconnect aborts the upstream generation", async () => {
    let sawCall = false;
    let abortedDuringGeneration = false;
    // Hang until the signal aborts, recording that the abort propagated to the
    // generator (i.e. the upstream OpenRouter call would be cancelled).
    __resetGenerateTemplateForTests(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          sawCall = true;
          signal?.addEventListener("abort", () => {
            abortedDuringGeneration = true;
            reject(new Error("aborted"));
          });
        }),
    );
    __setSseKeepaliveMsForTests(50);

    const controller = new AbortController();
    const pending = fetch(
      `${baseURL}/api/v2/agent-templates/generations/ephemeral`,
      {
        method: "POST",
        headers: sseApiKeyHeaders,
        body: JSON.stringify({ inputs: { idea: "x" } }),
        signal: controller.signal,
      },
    );

    // Let the server start the generation, then drop the connection.
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await pending.catch(() => {
      /* expected — client aborted */
    });

    // Give the server a tick to observe res `close` and propagate the abort.
    await new Promise((r) => setTimeout(r, 100));
    expect(sawCall).toBe(true);
    expect(abortedDuringGeneration).toBe(true);
  });
});
