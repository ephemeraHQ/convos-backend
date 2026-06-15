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
 * concrete OpenRouter id (`anthropic/claude-opus-4.8-fast`, see `DEFAULT_MODEL` in
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

// OpenRouter provider routing: prefer Amazon Bedrock (lower-latency Anthropic
// serving) but keep fallbacks on (the OpenRouter default) so models Bedrock
// doesn't serve — e.g. Google Gemini, used by moderation/reply — transparently
// route elsewhere. `order` is a *preference*, not a hard pin; an unavailable or
// throttled Bedrock falls back automatically, so this is self-healing. Confirm
// the actual latency win via PostHog p50 `$ai_latency` after deploy (segment by
// the `upstream_provider` recorded on `builder.generation.llm_call`).
const DEFAULT_PROVIDER_PREFERENCE = { order: ["amazon-bedrock"] };

// OpenRouter app attribution — populates the "App" entry in the OpenRouter
// dashboard. OpenRouter keys the app on HTTP-Referer and displays X-Title.
// A distinct title keeps builder spend separate from the runtime's
// "Hermes Agent" app (set by the Worker proxy in convos-assistants).
const OPENROUTER_ATTRIBUTION_HEADERS = {
  "HTTP-Referer": "https://agents.convos.org",
  "X-Title": "Convos Agents",
};

/** PostHog event recording the upstream provider that served one LLM call.
 *  One per call, alongside the wrapper's `$ai_generation`. */
export const LLM_CALL_EVENT = "builder.generation.llm_call";

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
    // Attribute every builder call to the "Convos Agents" app in OpenRouter.
    defaultHeaders: OPENROUTER_ATTRIBUTION_HEADERS,
    // Resolve the global fetch at call time so tests that reassign
    // `globalThis.fetch` still intercept the SDK's requests.
    fetch: (url: any, init?: any) => globalThis.fetch(url, init),
  };
  if (ph) {
    // PostHogOpenAI extends OpenAI structurally but TS sees a private-brand
    // mismatch (OpenAI carries a `#private` field that the @posthog/ai
    // re-export doesn't share). Cast through unknown to bridge the brand.
    return {
      client: new PostHogOpenAI({
        ...common,
        posthog: ph,
      }) as unknown as OpenAI,
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
    | "distill"
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
          // Correct the native `$ai_provider` field. The wrapper defaults it to
          // "openai" (the SDK), but we call OpenRouter — so the gateway is
          // OpenRouter. The *resolved upstream* it routed to (Bedrock /
          // Anthropic / Google) is only known post-response and has no native
          // field; that's captured separately on `builder.generation.llm_call`.
          posthogProviderOverride: "openrouter",
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

  const startedMs = performance.now();
  const response = await client.chat.completions.create(
    // `provider` is an OpenRouter extension (passed through by the OpenAI SDK).
    // Default first so a caller-supplied `body.provider` can still override.
    {
      provider: DEFAULT_PROVIDER_PREFERENCE,
      ...opts.body,
      ...monitoring,
    } as any,
    requestOptions,
  );

  // Record which upstream OpenRouter actually routed to. `$ai_provider` is the
  // native API-provider field (now "openrouter" — the gateway), but it can't
  // hold the resolved upstream: that's only on the response, after the wrapper
  // has captured `$ai_generation`. So we emit it ourselves to tell whether the
  // Bedrock preference took effect or fell back, and to segment latency by
  // upstream. Fire-and-forget; only on success (errors are captured by the
  // wrapper's own event).
  captureProviderTelemetry(opts, response, performance.now() - startedMs);
  return response;
}

/** Custom event recording the resolved upstream provider + served model for one
 *  OpenRouter call, so latency can be segmented by `upstream_provider` in
 *  PostHog. No-op when PostHog/trace is absent; never throws. */
function captureProviderTelemetry(
  opts: OpenRouterChatOptions,
  response: OpenAI.Chat.Completions.ChatCompletion,
  latencyMs: number,
): void {
  if (!opts.trace) return;
  const ph = getPostHogClient();
  if (!ph) return;
  try {
    const r = response as unknown as { model?: string; provider?: string };
    ph.capture({
      distinctId: opts.trace.distinctId ?? `request:${opts.trace.traceId}`,
      event: LLM_CALL_EVENT,
      properties: {
        ...opts.trace.properties,
        $ai_trace_id: opts.trace.traceId,
        ai_stage: opts.stage,
        requested_model: opts.body.model,
        served_model: r.model,
        // OpenRouter's resolved upstream (e.g. "Amazon Bedrock"); undefined on
        // providers/responses that don't report it.
        upstream_provider: r.provider,
        latency_ms: latencyMs,
      },
    });
  } catch {
    /* analytics never breaks the request */
  }
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
        // Caller-supplied trace properties first, so the reserved/computed
        // `$ai_*` span fields below always win — a stray `$ai_trace_id` (etc.)
        // in `trace.properties` can never clobber the real span identity.
        ...opts.trace.properties,
        $ai_trace_id: opts.trace.traceId,
        $ai_span_id: randomUUID(),
        ...(opts.parentId ? { $ai_parent_id: opts.parentId } : {}),
        $ai_span_name: opts.name,
        $ai_input_state: opts.inputState,
        $ai_output_state: opts.outputState,
        // PostHog documents `$ai_latency` in seconds.
        $ai_latency: (performance.now() - opts.startMs) / 1000,
        $ai_is_error: opts.error != null,
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
