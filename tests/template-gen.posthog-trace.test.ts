/**
 * PostHog LLM Analytics tracing for template generation.
 *
 * Verifies that OpenRouter calls routed through `openRouterChatCompletion`
 * emit a `$ai_generation` event into PostHog (via @posthog/ai's wrapper) when
 * a posthog client is configured — carrying the trace id, actor distinctId,
 * token counts, and our per-stage properties — and that no `posthog*`
 * monitoring keys leak into the request body sent to OpenRouter.
 *
 * When no posthog client is configured, the call falls back to a plain OpenAI
 * client: it still succeeds and sends a clean body, but emits nothing.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetOpenRouterClientForTests,
  openRouterChatCompletion,
  withAiSpan,
} from "@/api/v2/agent-templates/services/openrouter-client";
import { __setPostHogClientForTests } from "@/api/v2/agent-templates/services/posthog";

const originalFetch = globalThis.fetch;

interface CapturedEvent {
  event: string;
  distinctId?: string;
  properties?: Record<string, any>;
}

let lastSentBody: any = null;

function installFetch() {
  globalThis.fetch = (async (_url: any, init?: any) => {
    lastSentBody = init?.body ? JSON.parse(init.body) : null;
    return new Response(
      JSON.stringify({
        id: "cmpl-test",
        object: "chat.completion",
        created: 0,
        model: "anthropic/claude-sonnet-4.5",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;
}

beforeEach(() => {
  lastSentBody = null;
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setPostHogClientForTests(null);
  __resetOpenRouterClientForTests();
});

describe("openRouterChatCompletion + PostHog tracing", () => {
  test("emits $ai_generation with trace id, actor, tokens, and stage", async () => {
    const captured: CapturedEvent[] = [];
    const stub = {
      capture: (e: CapturedEvent) => captured.push(e),
      on: () => {},
    };
    __setPostHogClientForTests(stub);
    __resetOpenRouterClientForTests();

    const res = await openRouterChatCompletion({
      apiKey: "test-or-key",
      stage: "generate",
      body: {
        model: "anthropic/claude-opus-4.7",
        messages: [{ role: "user", content: "make me an agent" }],
        temperature: 0.7,
      },
      trace: {
        traceId: "gen-abc",
        distinctId: "acct-42",
        properties: { generation_id: "gen-abc", source: "web" },
      },
    });

    // Underlying call still returns the real completion.
    expect(res.choices[0]?.message?.content).toBe("ok");

    // Exactly one $ai_generation event.
    const gens = captured.filter((c) => c.event === "$ai_generation");
    expect(gens.length).toBe(1);

    const props = gens[0].properties ?? {};
    expect(gens[0].distinctId).toBe("acct-42");
    expect(props.$ai_trace_id).toBe("gen-abc");
    expect(props.$ai_input_tokens).toBe(11);
    expect(props.$ai_output_tokens).toBe(7);
    // Our per-call segmentation properties ride along.
    expect(props.ai_stage).toBe("generate");
    expect(props.generation_id).toBe("gen-abc");
    expect(props.source).toBe("web");

    // Monitoring params must NOT leak into the OpenRouter request body.
    const leaked = Object.keys(lastSentBody ?? {}).filter((k) =>
      k.startsWith("posthog"),
    );
    expect(leaked).toEqual([]);
    expect(lastSentBody.model).toBe("anthropic/claude-opus-4.7");
    // Provider routing prefers Bedrock (fallbacks left on by default).
    expect(lastSentBody.provider).toEqual({ order: ["amazon-bedrock"] });
  });

  test("no posthog client → no events, clean body, call still works", async () => {
    __setPostHogClientForTests(null);
    __resetOpenRouterClientForTests();

    const res = await openRouterChatCompletion({
      apiKey: "test-or-key",
      stage: "classifier",
      body: {
        model: "anthropic/claude-opus-4.7",
        messages: [{ role: "user", content: "classify" }],
      },
      trace: {
        traceId: "gen-xyz",
        distinctId: "acct-7",
        properties: { generation_id: "gen-xyz" },
      },
    });

    expect(res.choices[0]?.message?.content).toBe("ok");
    const leaked = Object.keys(lastSentBody ?? {}).filter((k) =>
      k.startsWith("posthog"),
    );
    expect(leaked).toEqual([]);
    // Provider routing applies on the plain-client path too.
    expect(lastSentBody.provider).toEqual({ order: ["amazon-bedrock"] });
  });

  test("same trace id groups multiple stages under one trace", async () => {
    const captured: CapturedEvent[] = [];
    const stub = {
      capture: (e: CapturedEvent) => captured.push(e),
      on: () => {},
    };
    __setPostHogClientForTests(stub);
    __resetOpenRouterClientForTests();

    for (const stage of ["selector", "classifier", "generate"] as const) {
      await openRouterChatCompletion({
        apiKey: "test-or-key",
        stage,
        body: {
          model: "anthropic/claude-opus-4.7",
          messages: [{ role: "user", content: stage }],
        },
        trace: { traceId: "gen-shared", distinctId: "acct-1" },
      });
    }

    const gens = captured.filter((c) => c.event === "$ai_generation");
    expect(gens.length).toBe(3);
    expect(new Set(gens.map((g) => g.properties?.$ai_trace_id))).toEqual(
      new Set(["gen-shared"]),
    );
    expect(gens.map((g) => g.properties?.ai_stage).sort()).toEqual([
      "classifier",
      "generate",
      "selector",
    ]);
  });
});

describe("withAiSpan (non-LLM enrichment spans)", () => {
  test("success emits $ai_span with trace id, name, output state, latency", async () => {
    const captured: CapturedEvent[] = [];
    __setPostHogClientForTests({
      capture: (e: CapturedEvent) => captured.push(e),
      on: () => {},
    });

    const out = await withAiSpan(
      { traceId: "gen-1", distinctId: "acct-1", properties: { source: "web" } },
      "exa.contents",
      { url: "https://example.com" },
      () => Promise.resolve("hello world"),
      (r) => ({ chars: r.length }),
    );

    expect(out).toBe("hello world");
    const spans = captured.filter((c) => c.event === "$ai_span");
    expect(spans.length).toBe(1);
    const p = spans[0].properties ?? {};
    expect(spans[0].distinctId).toBe("acct-1");
    expect(p.$ai_trace_id).toBe("gen-1");
    expect(p.$ai_span_name).toBe("exa.contents");
    expect(p.$ai_input_state).toEqual({ url: "https://example.com" });
    expect(p.$ai_output_state).toEqual({ chars: 11 });
    expect(p.$ai_is_error).toBe(false);
    expect(typeof p.$ai_span_id).toBe("string");
    expect(typeof p.$ai_latency).toBe("number");
    expect(p.source).toBe("web"); // trace properties ride along
  });

  test("error emits $ai_span with is_error=true and rethrows", async () => {
    const captured: CapturedEvent[] = [];
    __setPostHogClientForTests({
      capture: (e: CapturedEvent) => captured.push(e),
      on: () => {},
    });

    const boom = new Error("github 500");
    let caughtError: unknown;
    try {
      await withAiSpan(
        { traceId: "gen-2" },
        "github.api",
        { path: "/repos/x/y" },
        () => Promise.reject(boom),
      );
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBe(boom);

    const spans = captured.filter((c) => c.event === "$ai_span");
    expect(spans.length).toBe(1);
    expect(spans[0].properties?.$ai_is_error).toBe(true);
    expect(spans[0].properties?.$ai_span_name).toBe("github.api");
  });

  test("no posthog client → no span, fn still runs", async () => {
    __setPostHogClientForTests(null);
    __resetOpenRouterClientForTests();
    let ran = false;
    const out = await withAiSpan({ traceId: "gen-3" }, "github.raw", {}, () => {
      ran = true;
      return Promise.resolve("ok");
    });
    expect(ran).toBe(true);
    expect(out).toBe("ok");
  });

  test("no trace → no span, fn still runs", async () => {
    const captured: CapturedEvent[] = [];
    __setPostHogClientForTests({
      capture: (e: CapturedEvent) => captured.push(e),
      on: () => {},
    });
    const out = await withAiSpan(undefined, "exa.contents", {}, () =>
      Promise.resolve("ok"),
    );
    expect(out).toBe("ok");
    expect(captured.filter((c) => c.event === "$ai_span").length).toBe(0);
  });

  test("trace.properties cannot clobber reserved span fields", async () => {
    const captured: CapturedEvent[] = [];
    __setPostHogClientForTests({
      capture: (e: CapturedEvent) => captured.push(e),
      on: () => {},
    });
    await withAiSpan(
      {
        traceId: "real-trace",
        properties: {
          $ai_trace_id: "evil",
          $ai_span_name: "evil",
          source: "web",
        },
      },
      "github.api",
      {},
      () => Promise.resolve("ok"),
    );
    const span = captured.find((c) => c.event === "$ai_span");
    expect(span?.properties?.$ai_trace_id).toBe("real-trace");
    expect(span?.properties?.$ai_span_name).toBe("github.api");
    // Non-reserved custom properties still pass through.
    expect(span?.properties?.source).toBe("web");
  });
});
