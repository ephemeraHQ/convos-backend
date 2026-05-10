/**
 * PostHog metering for the builder template generation endpoint.
 *
 * Fires a single `builder.template.generated` event per `/generate`
 * invocation that reaches the LLM call (both success and error paths).
 * Capture is fire-and-forget — no blocking await on `capture()` or
 * `flush()`. Missing `POSTHOG_API_KEY`/`POSTHOG_HOST` env vars are
 * a silent no-op (the SDK never initialises, no outbound requests).
 *
 * Test seam: `__resetPostHogForTests(override)` mirrors the
 * `__resetComposioServiceForTests` / `__resetGenerateTemplateForTests`
 * singleton-override pattern used throughout the codebase.
 */

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

import type { GenerationMetrics } from "./templateGen";

// ---------------------------------------------------------------------------
// Event name — single source of truth
// ---------------------------------------------------------------------------

export const BUILDER_TEMPLATE_GENERATED_EVENT = "builder.template.generated";

// ---------------------------------------------------------------------------
// Properties interface
// ---------------------------------------------------------------------------

export interface PostHogCaptureProperties extends GenerationMetrics {
  /** Fresh UUID v4 per request — correlates logs to the metering event. */
  requestId: string;
  /** How the request was authenticated: "jwt" or "agentKey". */
  authMode: "jwt" | "agentKey";
  /** Source of the generation event — e.g. "create-job" for async job executor. */
  source?: string;
  /** Account ID of the template/job owner. */
  ownerAccountId?: string;
  /** Input type used for generation: "text", "pdfBase64", or "imageBase64". */
  inputType?: string;
}

// ---------------------------------------------------------------------------
// Lazy PostHog client singleton
// ---------------------------------------------------------------------------

let _posthogClient: any = null;

/**
 * Return the PostHog client if both env vars are set, otherwise `null`.
 * The client is created once and cached for the lifetime of the process.
 * Lazy-loads `posthog-node` so the import cost is only paid when the
 * feature is actually configured.
 */
function getPostHogClient(): any {
  if (_posthogClient) return _posthogClient;

  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST;
  if (!apiKey || !host) return null;

  // Dynamic import would require top-level await; use require() for
  // synchronous lazy init at call time (matches mission constraint).
  const { PostHog } = require("posthog-node") as {
    PostHog: new (apiKey: string, opts: { host: string }) => any;
  };
  _posthogClient = new PostHog(apiKey, { host });
  return _posthogClient;
}

// ---------------------------------------------------------------------------
// Test seam — mirrors __resetGenerateTemplateForTests pattern
// ---------------------------------------------------------------------------

let _captureOverride: ((properties: PostHogCaptureProperties) => void) | null =
  null;

/**
 * Install a test override for the PostHog capture.
 * Pass `null` to restore normal behaviour.
 * Also resets the cached PostHog client so env-var changes take effect.
 */
export function __resetPostHogForTests(
  override: ((properties: PostHogCaptureProperties) => void) | null,
) {
  _captureOverride = override;
  _posthogClient = null;
}

// ---------------------------------------------------------------------------
// Capture function — fire-and-forget
// ---------------------------------------------------------------------------

/**
 * Fire a `builder.template.generated` PostHog event.
 *
 * - When a test override is installed, delegates to the override.
 * - When `POSTHOG_API_KEY`/`POSTHOG_HOST` are unset, returns immediately (no-op).
 * - Otherwise, calls `posthog.capture()` which is buffered/async internally —
 *   we do NOT await it, keeping the route response fast.
 */
export function capturePostHog(properties: PostHogCaptureProperties): void {
  if (_captureOverride) {
    _captureOverride(properties);
    return;
  }

  const client = getPostHogClient();
  if (!client) return; // silent no-op when env not set

  // Fire-and-forget: capture is buffered internally by the SDK.
  // No await — the route returns immediately. Wrap in try/catch so a
  // synchronous SDK failure (serialization, internal state) cannot bubble
  // up and break the request that triggered this analytics call.
  try {
    client.capture({
      distinctId: "builder",
      event: BUILDER_TEMPLATE_GENERATED_EVENT,
      properties,
    });
  } catch (err) {
    console.error(
      "[posthog] capture failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
