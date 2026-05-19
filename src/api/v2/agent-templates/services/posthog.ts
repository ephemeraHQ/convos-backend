/**
 * PostHog metering for the builder template generation endpoint.
 *
 * Fires a single `builder.generation.completed` event per generation
 * pipeline invocation that reaches the LLM call (both success and error
 * paths). Capture is fire-and-forget — no blocking await on `capture()` or
 * `flush()`. A missing `POSTHOG_PROJECT_TOKEN` is a silent no-op (the SDK
 * never initialises, no outbound requests). `POSTHOG_HOST` defaults to
 * PostHog Cloud US in `config.ts`, so setting only the token Just Works.
 *
 * Test seam: `__resetPostHogForTests(override)` mirrors the
 * `__resetComposioServiceForTests` / `__resetGenerateTemplateForTests`
 * singleton-override pattern used throughout the codebase.
 */

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

import { POSTHOG_HOST, POSTHOG_PROJECT_TOKEN } from "@/config";
import logger from "@/utils/logger";
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
  /** Account ID of the generation owner. Present whether or not the row
   *  was anonymous — anonymous rows are owned by the admin sentinel. Use
   *  `isAnonymous` to disambiguate. */
  ownerAccountId?: string;
  /** True when the row is owned by the admin sentinel (no real account).
   *  When true, `ownerAccountId` is NOT used for actor attribution. */
  isAnonymous?: boolean;
  /** Twitter user identifier (handle, lowercased, '@' stripped) when the
   *  generation was triggered via the twitter bot. Used as a fallback
   *  actor identifier when there's no `ownerAccountId`. */
  twitterUserId?: string;
  /** Stable device identifier supplied by the client (e.g. posthog-js's
   *  `$device_id` cookie). Used as a fallback actor identifier when the
   *  user hasn't authenticated. */
  clientDeviceId?: string;
  /** Input type used for generation: "text", "pdfBase64", or "imageBase64". */
  inputType?: string;
  /** Terminal outcome: "done" or "failed". */
  outcome?: "done" | "failed";
  /** How the request was authenticated. Optional — present only when known. */
  authMode?: "jwt" | "agentKey";
}

// ---------------------------------------------------------------------------
// Actor attribution — the distinctId precedence ladder
// ---------------------------------------------------------------------------

/**
 * Kind of identifier used as `distinctId` on the event. Sent as a top-level
 * `actorKind` property so downstream queries can segment by attribution type
 * without parsing the distinctId string. Survives prefix-convention changes;
 * makes post-merge analytics on aliased persons trivial.
 */
export type ActorKind = "account" | "device" | "twitter" | "unattributed";

export interface ResolvedActor {
  distinctId: string;
  kind: ActorKind;
}

/**
 * Resolve the distinctId + kind to send with the event from the available
 * signals. Precedence:
 *
 *   1. `<ownerAccountId>` (real account)      — kind: `account`        — most stable.
 *   2. `device:<clientDeviceId>`              — kind: `device`         — anonymous web/iOS.
 *   3. `twitter:<twitterUserId>`              — kind: `twitter`        — anonymous twitter-bot.
 *   4. `request:<requestId>`                  — kind: `unattributed`   — one-off fallback.
 *
 * Each non-account rung is namespaced (`device:`, `twitter:`, `request:`) so an
 * anonymous identifier never collides with a real account UUID — which is the
 * load-bearing property for safe `posthog.alias()` merges later: when an
 * anonymous user authenticates, the frontend can alias `device:<X>` into the
 * account UUID without risking a cross-person merge.
 *
 * Reasoning: anonymous web/twitter submissions still populate `ownerAccountId`
 * — the route uses `ADMIN_ACCOUNT_ID` as the system-identity fallback so the
 * row has a valid owner FK. Using that sentinel directly as distinctId would
 * collapse every anonymous submission onto a single PostHog person and defeat
 * the point of analytics. The executor sets `isAnonymous: true` when the
 * owner is the sentinel so this function skips to the next rung.
 *
 * `kind: "unattributed"` is the honest name for rung 4 — every event in this
 * file is a generation, so calling rung 4 "generation" would conflate event
 * type with actor identity. `unattributed` says what's actually true: we
 * have no stable actor signal and each event gets a one-off person.
 */
export function resolveActor(p: PostHogCaptureProperties): ResolvedActor {
  if (p.ownerAccountId && !p.isAnonymous) {
    return { distinctId: p.ownerAccountId, kind: "account" };
  }
  if (p.clientDeviceId) {
    return { distinctId: `device:${p.clientDeviceId}`, kind: "device" };
  }
  if (p.twitterUserId) {
    return { distinctId: `twitter:${p.twitterUserId}`, kind: "twitter" };
  }
  return { distinctId: `request:${p.requestId}`, kind: "unattributed" };
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

  if (!POSTHOG_PROJECT_TOKEN || !POSTHOG_HOST) return null;

  // Dynamic import would require top-level await; use require() for
  // synchronous lazy init at call time (matches mission constraint).
  const { PostHog } = require("posthog-node") as {
    PostHog: new (apiKey: string, opts: { host: string }) => any;
  };
  _posthogClient = new PostHog(POSTHOG_PROJECT_TOKEN, { host: POSTHOG_HOST });
  // Surface async capture failures (auth 401s on a wrong token, wrong host,
  // network errors). capture() is fire-and-forget so these are otherwise
  // invisible — the request that triggered it has already returned. Subscribe
  // once at client creation; client is cached for the lifetime of the process.
  _posthogClient.on("error", (err: unknown) => {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      "[posthog] async capture error",
    );
  });
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
 * - When `POSTHOG_PROJECT_TOKEN` is unset, returns immediately (no-op).
 * - Otherwise, calls `posthog.capture()` which is buffered/async internally —
 *   we do NOT await it, keeping the route response fast.
 */
export function capturePostHog(properties: PostHogCaptureProperties): void {
  if (_captureOverride) {
    _captureOverride(properties);
    return;
  }

  // Fire-and-forget: capture is buffered internally by the SDK.
  // No await — the route returns immediately. Wrap in try/catch so a
  // synchronous SDK failure (serialization, internal state, or lazy
  // `require("posthog-node")` / `new PostHog()` failure inside
  // getPostHogClient) cannot bubble up and break the request that
  // triggered this analytics call.
  try {
    const client = getPostHogClient();
    if (!client) return; // silent no-op when env not set

    const actor = resolveActor(properties);
    client.capture({
      distinctId: actor.distinctId,
      event: BUILDER_GENERATION_COMPLETED_EVENT,
      // Carry the rung as a property so dashboards can segment by
      // attribution type without parsing prefixes off `distinct_id`.
      properties: { ...properties, actorKind: actor.kind },
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      "[posthog] capture failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Flush any buffered events and tear down the PostHog client. Call once
 * during SIGTERM so events captured in the last `flushInterval` window
 * (default 10s in posthog-node v5) aren't lost when the process exits.
 *
 * No-op when the client was never created (env vars unset, or test
 * override installed). Errors are caught and logged — never propagate
 * to the caller so shutdown can continue.
 */
export async function shutdownPostHog(timeoutMs = 5000): Promise<void> {
  const client = _posthogClient;
  if (!client) return;
  _posthogClient = null;
  try {
    await client.shutdown(timeoutMs);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      "[posthog] shutdown failed",
    );
  }
}
