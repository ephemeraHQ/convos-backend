/**
 * OpenRouter client + PostHog LLM Analytics tracing for template generation.
 *
 * Wraps the OpenAI SDK (OpenRouter is OpenAI-compatible) so every chat
 * completion the builder makes — GitHub selector, content classifier, and the
 * main generation — emits a `$ai_generation` event into PostHog LLM Analytics.
 *
 * Why the `@posthog/ai` *wrapper* (not the OTel `PostHogSpanProcessor`):
 * `src/instrumentation.ts` already runs a NodeSDK that exports every HTTP /
 * Express / Prisma span to an OTLP collector. Adding the OTel processor would
 * fan all of those spans into PostHog too. The wrapper captures `$ai_*` events
 * straight through the existing `posthog-node` client instead — off the OTLP
 * pipeline, and with explicit per-call `traceId` / `distinctId` control so the
 * three calls in one generation group under a single trace attributed to the
 * same actor as the `builder.generation.completed` product event.
 *
 * When `POSTHOG_PROJECT_TOKEN` is unset, `getPostHogClient()` returns null and
 * we fall back to a plain OpenAI client — no tracing, no monitoring params, no
 * behavioural change. A custom `fetch` delegates to `globalThis.fetch` at call
 * time so existing fetch-mocking tests keep working, and `maxRetries: 0`
 * preserves the old single-attempt semantics of the raw-fetch code.
 *
 * Model attribution note: the wrapper records the *requested* model as
 * `$ai_model` (`openAIParams.model ?? result.model`). The default model is a
 * concrete OpenRouter id (`anthropic/claude-opus-4.7`, see `DEFAULT_MODEL` in
 * templateGen.ts), so PostHog prices `$ai_total_cost_usd` automatically. A
 * `BUILDER_MODEL` override should also be a concrete id (not an OpenRouter
 * `@preset/...` alias, which PostHog can't price) to keep cost resolving.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { randomUUID } from "node:crypto";
import { OpenAI as PostHogOpenAI } from "@posthog/ai/openai";
import { OpenAI } from "openai";
import { getPostHogClient } from "@/api/v2/agent-templates/services/posthog";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Per-generation trace context threaded from the executor down to each LLM
 * call. `traceId` groups the calls under one PostHog LLM Analytics trace;
 * `distinctId` attributes them to the same actor as the product event;
 * `properties` are merged into every `$ai_generation` for segmentation.
 */
export interface TraceContext {
  traceId: string;
  distinctId?: string;
  properties?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Client singleton — rebuilt when the api key or posthog client changes
// (both can change between tests via their override seams).
// ---------------------------------------------------------------------------

let _client: OpenAI | null = null;
let _clientKey: string | null = null;
let _clientPh: unknown = null;
let _clientWrapped = false;

function buildClient(apiKey: string): { client: OpenAI; wrapped: boolean } {
  const ph = getPostHogClient();
  const common = {
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    // The raw-fetch code made a single attempt; keep that so error/timeout
    // tests don't see silent retries.
    maxRetries: 0,
    // Resolve the global fetch at call time so tests that reassign
    // `globalThis.fetch` still intercept the SDK's requests.
    fetch: (url: any, init?: any) => globalThis.fetch(url, init),
  };
  if (ph) {
    return {
      client: new PostHogOpenAI({ ...common, posthog: ph }),
      wrapped: true,
    };
  }
  return { client: new OpenAI(common), wrapped: false };
}

function getClient(apiKey: string): { client: OpenAI; wrapped: boolean } {
  const ph = getPostHogClient();
  if (_client && _clientKey === apiKey && _clientPh === ph) {
    return { client: _client, wrapped: _clientWrapped };
  }
  const built = buildClient(apiKey);
  _client = built.client;
  _clientKey = apiKey;
  _clientPh = ph;
  _clientWrapped = built.wrapped;
  return built;
}

/** Clear the cached client. Test seam — call after changing the api key or
 *  injecting a posthog client so the next call rebuilds the wrapper. */
export function __resetOpenRouterClientForTests(): void {
  _client = null;
  _clientKey = null;
  _clientPh = null;
  _clientWrapped = false;
}

// ---------------------------------------------------------------------------
// Chat completion entrypoint
// ---------------------------------------------------------------------------

export interface OpenRouterChatOptions {
  apiKey: string;
  /** Logical pipeline stage — recorded as a property on the `$ai_generation`
   *  for per-stage segmentation. */
  stage:
    | "selector"
    | "classifier"
    | "generate"
    | "moderation"
    | "twitter-intent"
    | "compose-reply";
  body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
  /** External cancellation (e.g. the executor's per-generation timeout). */
  signal?: AbortSignal;
  /** Per-request wallclock cap in ms. */
  timeoutMs?: number;
  /** Trace context. Omitted/no-op when PostHog isn't configured. */
  trace?: TraceContext;
}

/**
 * Make one OpenRouter chat completion. When PostHog is configured the call is
 * routed through `@posthog/ai`'s wrapper, which auto-emits a `$ai_generation`
 * (input, output, tokens, latency) tagged with the trace context. Otherwise it
 * is a plain OpenAI SDK call. Errors propagate to the caller unchanged so each
 * call site keeps its own error handling.
 */
export async function openRouterChatCompletion(
  opts: OpenRouterChatOptions,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const { client, wrapped } = getClient(opts.apiKey);

  // Monitoring params are only valid on the wrapped client; the plain OpenAI
  // client would forward unknown `posthog*` keys to OpenRouter as body fields.
  const monitoring =
    wrapped && opts.trace
      ? {
          posthogTraceId: opts.trace.traceId,
          posthogDistinctId: opts.trace.distinctId,
          posthogProperties: {
            ...opts.trace.properties,
            ai_stage: opts.stage,
          },
        }
      : {};

  // Only set request options that are defined — the OpenAI SDK validates
  // `timeout` as a positive integer and rejects an explicit `undefined`.
  const requestOptions: Record<string, unknown> = {};
  if (opts.signal) requestOptions.signal = opts.signal;
  if (typeof opts.timeoutMs === "number")
    requestOptions.timeout = opts.timeoutMs;

  return client.chat.completions.create(
    { ...opts.body, ...monitoring } as any,
    requestOptions,
  );
}

// ---------------------------------------------------------------------------
// Non-LLM spans ($ai_span)
//
// The @posthog/ai wrapper only auto-emits `$ai_generation` for the LLM calls
// it wraps. Non-LLM enrichment steps (Exa, Twitter oEmbed, GitHub) have no
// wrapper, so we emit `$ai_span` events manually through the same posthog-node
// client — they stitch into the generation's trace by `$ai_trace_id`. Property
// shape mirrors PostHog's trace UI (and Hermes' tool-span emitter).
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget `$ai_span` capture. No-op when PostHog is unconfigured or no
 * trace context is supplied. Never throws — analytics must not break a request.
 */
export function captureAiSpan(opts: {
  trace?: TraceContext;
  /** Span label, e.g. "exa.contents", "github.raw". */
  name: string;
  /** `performance.now()` captured when the step started. */
  startMs: number;
  inputState?: unknown;
  outputState?: unknown;
  /** Optional parent span id; omit to attach at the trace root. */
  parentId?: string;
  error?: unknown;
}): void {
  if (!opts.trace) return;
  const ph = getPostHogClient();
  if (!ph) return;
  try {
    ph.capture({
      distinctId: opts.trace.distinctId ?? `request:${opts.trace.traceId}`,
      event: "$ai_span",
      properties: {
        $ai_trace_id: opts.trace.traceId,
        $ai_span_id: randomUUID(),
        ...(opts.parentId ? { $ai_parent_id: opts.parentId } : {}),
        $ai_span_name: opts.name,
        $ai_input_state: opts.inputState,
        $ai_output_state: opts.outputState,
        // PostHog documents `$ai_latency` in seconds.
        $ai_latency: (performance.now() - opts.startMs) / 1000,
        $ai_is_error: opts.error != null,
        ...opts.trace.properties,
      },
    });
  } catch {
    /* analytics never breaks the request */
  }
}

/**
 * Run an async non-LLM step and emit one `$ai_span` for it (success or error).
 * No-op tracing when `trace` is undefined; the wrapped function always runs.
 */
export async function withAiSpan<T>(
  trace: TraceContext | undefined,
  name: string,
  inputState: unknown,
  fn: () => Promise<T>,
  outputState?: (result: T) => unknown,
): Promise<T> {
  const startMs = performance.now();
  try {
    const result = await fn();
    captureAiSpan({
      trace,
      name,
      startMs,
      inputState,
      outputState: outputState?.(result),
    });
    return result;
  } catch (error) {
    captureAiSpan({ trace, name, startMs, inputState, error });
    throw error;
  }
}

export { OPENROUTER_BASE_URL };
