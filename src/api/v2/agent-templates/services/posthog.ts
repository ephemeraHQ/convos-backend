/**
 * PostHog metering for the builder template generation endpoint.
 *
 * Fires a single `builder.generation.completed` event per generation
 * pipeline invocation that reaches the LLM call (both success and error
 * paths). Capture is fire-and-forget — no blocking await on `capture()` or
 * `flush()`. Missing `POSTHOG_API_KEY`/`POSTHOG_HOST` env vars are
 * a silent no-op (the SDK never initialises, no outbound requests).
 *
 * Test seam: `__resetPostHogForTests(override)` mirrors the
 * `__resetComposioServiceForTests` / `__resetGenerateTemplateForTests`
 * singleton-override pattern used throughout the codebase.
 */

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

import { POSTHOG_API_KEY, POSTHOG_HOST } from "@/config";
import type { GenerationMetrics } from "./templateGen";

// ---------------------------------------------------------------------------
// Event name — single source of truth
// ---------------------------------------------------------------------------

export const BUILDER_GENERATION_COMPLETED_EVENT =
  "builder.generation.completed";

/** @deprecated Renamed to BUILDER_GENERATION_COMPLETED_EVENT in the
 *  /generations refactor. Kept exported so any external dashboards/queries
 *  that still reference the legacy constant don't TypeError. */
export const BUILDER_TEMPLATE_GENERATED_EVENT =
  BUILDER_GENERATION_COMPLETED_EVENT;

// ---------------------------------------------------------------------------
// Properties interface
// ---------------------------------------------------------------------------

export interface PostHogCaptureProperties extends GenerationMetrics {
  /** Generation ID (used as the request correlation ID in logs). */
  requestId: string;
  /** Source field from the AgentTemplateGeneration row — free-form
   *  client telemetry tag (e.g. "ios-app", "web", "twitter-bot"). */
  source?: string;
  /** Account ID of the generation owner. */
  ownerAccountId?: string;
  /** Input type used for generation: "text", "pdfBase64", or "imageBase64". */
  inputType?: string;
  /** Terminal outcome: "done" or "failed". */
  outcome?: "done" | "failed";
  /** How the request was authenticated. Optional — present only when known. */
  authMode?: "jwt" | "agentKey";
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

  if (!POSTHOG_API_KEY || !POSTHOG_HOST) return null;

  // Dynamic import would require top-level await; use require() for
  // synchronous lazy init at call time (matches mission constraint).
  const { PostHog } = require("posthog-node") as {
    PostHog: new (apiKey: string, opts: { host: string }) => any;
  };
  _posthogClient = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST });
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
      event: BUILDER_GENERATION_COMPLETED_EVENT,
      properties,
    });
  } catch (err) {
    console.error(
      "[posthog] capture failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
