/**
 * Application Configuration
 *
 * Environment variables are cached at module load time for performance.
 * This avoids repeated process.env lookups and provides a single source of truth.
 */

// Validate required environment variables
if (!process.env.XMTP_NOTIFICATION_SECRET) {
  throw new Error("XMTP_NOTIFICATION_SECRET is not configured");
}

if (!process.env.NOTIFICATION_SERVER_URL) {
  throw new Error("NOTIFICATION_SERVER_URL is not configured");
}

// Cache environment variables
export const XMTP_NOTIFICATION_SECRET = process.env.XMTP_NOTIFICATION_SECRET;

// v2 JWT (asymmetric ECDSA ES256)
// Keys are optional at config load time, but validated at server startup via validateJWTKeys()
export const JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY || "";
export const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || "";

export const JWT_ISSUER = "convos.org";
export const NOTIFICATION_SERVER_URL = process.env.NOTIFICATION_SERVER_URL;
export const NODE_ENV = process.env.NODE_ENV || "development";
export const IS_PRODUCTION = process.env.NODE_ENV === "production";
export const IS_DEVELOPMENT = process.env.NODE_ENV === "development";

// Assistant runtime service (convos-assistants). Backs
// /api/v2/agents/join + /.well-known/agents.json.
// ASSISTANT_API_KEY is optional — set if the deployed assistants service
// requires a bearer token in front of POST /api/assistants.
export const ASSISTANT_API_URL = (process.env.ASSISTANT_API_URL || "").trim();
export const ASSISTANT_API_KEY = (process.env.ASSISTANT_API_KEY || "").trim();

// Fail-fast at startup when ASSISTANT_API_URL is missing — matches the
// throw-on-missing pattern for other required envs in this file
// (SIWE_DOMAIN, SIWE_URI, NONCE_HMAC_SECRET). Surfaces misconfig at deploy
// time instead of as 503s on the first user join attempt.
if (!ASSISTANT_API_URL) {
  throw new Error("ASSISTANT_API_URL is not configured");
}

// Reject plaintext ASSISTANT_API_URL deployments — the bearer key would
// otherwise ride the wire in cleartext. Allow http://localhost for local
// dev so `wrangler dev` against convos-assistants on 127.0.0.1 still works.
const parsedAssistantUrl = (() => {
  try {
    return new URL(ASSISTANT_API_URL);
  } catch {
    throw new Error(
      `ASSISTANT_API_URL is not a valid URL: ${ASSISTANT_API_URL}`,
    );
  }
})();
const isLocalHost =
  parsedAssistantUrl.hostname === "localhost" ||
  parsedAssistantUrl.hostname === "127.0.0.1" ||
  parsedAssistantUrl.hostname.endsWith(".test.local");
if (parsedAssistantUrl.protocol !== "https:" && !isLocalHost) {
  throw new Error(
    `ASSISTANT_API_URL must use https:// (got ${parsedAssistantUrl.protocol}). ` +
      `Plaintext is only permitted for localhost / *.test.local hosts.`,
  );
}

// Agent asset upload auth (optional — endpoint returns 503 if not configured)
export const AGENT_ASSETS_API_KEY = process.env.AGENT_ASSETS_API_KEY || "";

// Composio (optional — /v2/connections/* endpoints return 503 if not configured).
// Auth configs are resolved dynamically from Composio by toolkit slug; no local mapping.
export const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || "";
// Dedicated credential for POST /v2/composio/exec — held ONLY by the trusted
// assistants worker, never forwarded into the agent container. Distinct from
// AGENT_ASSETS_API_KEY so the worker's generic convos.internal proxy (which
// injects the agent key for any backend path) cannot satisfy the exec auth.
// Endpoint returns 503 if unset.
export const COMPOSIO_EXEC_API_KEY = process.env.COMPOSIO_EXEC_API_KEY || "";
export const COMPOSIO_CONNECTION_CALLBACK_URL =
  process.env.COMPOSIO_CONNECTION_CALLBACK_URL ||
  "convos://connections/callback";

export const XMTP_ENV = process.env.XMTP_ENV || "dev";

// Deployment environment tag (e.g. convos-otr-dev, convos-otr-prod). Used for
// telemetry resource attributes. Mirrors the value the OTel instrumentation reads.
export const ENV = process.env.ENV || "development";

// SIWE / nonce-cookie auth (required)
if (!process.env.SIWE_DOMAIN) {
  throw new Error("SIWE_DOMAIN is not configured");
}
if (!process.env.SIWE_URI) {
  throw new Error("SIWE_URI is not configured");
}
if (
  !process.env.NONCE_HMAC_SECRET ||
  process.env.NONCE_HMAC_SECRET.length < 64
) {
  throw new Error(
    "NONCE_HMAC_SECRET is not configured or too short (need >= 64 chars / 32 bytes hex)",
  );
}

const parsedChainIds = (process.env.SIWE_ALLOWED_CHAIN_IDS || "1")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => {
    if (!/^[0-9]+$/.test(s)) {
      throw new Error(
        `SIWE_ALLOWED_CHAIN_IDS contains invalid chain id: "${s}"`,
      );
    }
    const n = parseInt(s, 10);
    if (n <= 0) {
      throw new Error(
        `SIWE_ALLOWED_CHAIN_IDS contains invalid chain id: "${s}"`,
      );
    }
    return n;
  });
if (parsedChainIds.length === 0) {
  throw new Error("SIWE_ALLOWED_CHAIN_IDS must contain at least one chain id");
}

export const SIWE_DOMAIN = process.env.SIWE_DOMAIN;
export const SIWE_URI = process.env.SIWE_URI;
export const SIWE_ALLOWED_CHAIN_IDS: readonly number[] = parsedChainIds;
export const NONCE_HMAC_SECRET = process.env.NONCE_HMAC_SECRET;

// Builder / template-gen + moderation (optional — services fail open / no-op
// when these are unset; cached at module-load to avoid call-time process.env
// reads on every generation).
export const BUILDER_OPENROUTER_API_KEY =
  process.env.BUILDER_OPENROUTER_API_KEY?.trim() || "";
export const BUILDER_MODEL = process.env.BUILDER_MODEL?.trim() || "";
// Cheap model for the pre-generation passthrough classifier
// (`classifyPastedContent`); concrete OpenRouter id so PostHog can price it.
export const BUILDER_CLASSIFIER_MODEL =
  process.env.BUILDER_CLASSIFIER_MODEL?.trim() || "minimax/minimax-m3";
export const CONTENT_MODERATION_MODEL =
  process.env.CONTENT_MODERATION_MODEL?.trim() ||
  "google/gemini-3.1-flash-lite";
// PII redaction scan run at persist time over the generated template
// (agentName/description/prompt). Cheap classifier — concrete OpenRouter id so
// PostHog can price it. Unlike moderation this stage fails CLOSED (see
// services/pii-redaction.ts): a shared/persisted artifact must never carry
// un-scanned PII, so a scan failure fails the generation.
export const PII_REDACTION_MODEL =
  process.env.PII_REDACTION_MODEL?.trim() || "google/gemini-3.1-flash-lite";
export const BUILDER_EXA_SERVICE_KEY =
  process.env.BUILDER_EXA_SERVICE_KEY?.trim() || "";

// Braintrust bench prompt store — backs per-PR agent variant builder-prompt
// resolution, project "convos-agent-bench". Optional: when unset,
// variant builder-prompt resolution fails open and the generation falls back
// to the canonical generator. Dev-only feature; never set on prod.
export const BRAINTRUST_API_KEY = process.env.BRAINTRUST_API_KEY?.trim() || "";

// Twitter reply composition (optional — only fires when twitterContext is
// present on a generation). The twitter intent check reuses
// CONTENT_MODERATION_MODEL (both are the same cheap-classifier knob).
export const TWITTER_REPLY_MODEL =
  process.env.TWITTER_REPLY_MODEL?.trim() || "google/gemini-3.1-flash-lite";
// Required — public template URLs (`<origin>/a/<slug>`) are user-facing, so a
// missing value must fail the deploy rather than silently misroute to a wrong
// origin. Tests seed it via tests/preload.ts.
const builderSiteUrl = process.env.BUILDER_SITE_URL?.trim();
if (!builderSiteUrl) {
  throw new Error("BUILDER_SITE_URL is not configured");
}
export const BUILDER_SITE_URL = builderSiteUrl;

// Shared bearer for the assistants-dashboard /api/revalidate webhook. When
// unset, the revalidate service no-ops (relies on the dashboard's 60s TTL
// fallback). Reuses BUILDER_SITE_URL as the dashboard base — see
// services/revalidate-dashboard.ts.
export const BUILDER_REVALIDATE_SECRET =
  process.env.BUILDER_REVALIDATE_SECRET?.trim() || "";

// PostHog metering (optional — capture is no-op if the token is unset).
// Host defaults to PostHog Cloud US so setting only the token Just Works.
export const POSTHOG_PROJECT_TOKEN =
  process.env.POSTHOG_PROJECT_TOKEN?.trim() || "";
export const POSTHOG_HOST =
  process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com";

// Generation pipeline timing knobs (override via env in tests / staging).
const parsePositiveInt = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const GENERATION_TTL_HOURS = parsePositiveInt(
  process.env.GENERATION_TTL_HOURS,
  24,
);
export const GENERATION_STUCK_SWEEP_THRESHOLD_MS = parsePositiveInt(
  process.env.GENERATION_STUCK_SWEEP_THRESHOLD_MS,
  10 * 60 * 1000,
);
export const GENERATION_EXECUTOR_TIMEOUT_MS = parsePositiveInt(
  process.env.GENERATION_EXECUTOR_TIMEOUT_MS,
  5 * 60 * 1000,
);

// Rough client-facing estimate of how long a build takes, surfaced as
// `estimatedDurationMs` on the in-progress (202) poll responses so a client can
// size its progress indicator without measuring. Text-only builds run ~20s on
// the live builder model (p90); attachments add fetch + moderation + multimodal
// overhead, so a build carrying any is estimated at ~30s. Env-tunable.
export const GENERATION_ESTIMATE_MS = parsePositiveInt(
  process.env.GENERATION_ESTIMATE_MS,
  20_000,
);
export const GENERATION_ESTIMATE_WITH_ATTACHMENTS_MS = parsePositiveInt(
  process.env.GENERATION_ESTIMATE_WITH_ATTACHMENTS_MS,
  30_000,
);

// ---------------------------------------------------------------------------
// Agent-build attachments (private-bucket upload → backend fetch)
// ---------------------------------------------------------------------------
// Private S3 bucket the builder uploads generation attachments to (images,
// PDFs, voice). Distinct from PUBLIC_ASSETS_BUCKET: the backend reads these
// bytes itself for generation + moderation, so the content never gets a
// public CDN URL. Unset → the attachment endpoints return 503 (mirrors the
// public presigned handler). Named generically (not BUILD_*) because it's the
// same private bucket other private-content features target.
export const PRIVATE_ASSETS_BUCKET = (
  process.env.PRIVATE_ASSETS_BUCKET || ""
).trim();

// Max attachments per generation. The Convos multi-attachment message tops out
// at 9, so that's the ceiling here too.
export const BUILD_ATTACHMENTS_MAX_COUNT = Math.min(
  9,
  parsePositiveInt(process.env.BUILD_ATTACHMENTS_MAX_COUNT, 9),
);

// Aggregate cap across all attachments on one generation (bytes). Per-file
// caps are class-specific (image vs pdf vs audio) and live in
// services/build-attachments.ts, set against real vision-model ceilings.
// 100 MiB fits a full batch either way: 9 images (9 × 10 MiB) or 4 pdf/audio
// (4 × 25 MiB). Clamped to the default so an env override can only lower it,
// never raise the executor's worst-case memory footprint (mirrors the count
// clamp above).
export const BUILD_ATTACHMENTS_MAX_TOTAL_BYTES = Math.min(
  100 * 1024 * 1024,
  parsePositiveInt(
    process.env.BUILD_ATTACHMENTS_MAX_TOTAL_BYTES,
    100 * 1024 * 1024,
  ),
);

// Audio-capable model that transcribes voice attachments to text before
// generation (the builder model can't take audio). Override per-env; the
// concrete format support (e.g. m4a) depends on the chosen model.
export const BUILD_TRANSCRIBE_MODEL =
  process.env.BUILD_TRANSCRIBE_MODEL?.trim() || "google/gemini-3.1-flash-lite";

// Minimum Rekognition label confidence (%) to treat an image attachment as
// unsafe — AWS's recommended default for a block decision, tunable per-env
// without a deploy. Clamped to 1–100 (it's a percentage); out-of-range or
// non-numeric values fall back to the default.
export const IMAGE_MODERATION_MIN_CONFIDENCE = Math.min(
  100,
  parsePositiveInt(process.env.IMAGE_MODERATION_MIN_CONFIDENCE, 60),
);

// Server-side wait knobs for POST /api/v2/agents/join — the handler blocks
// while the upstream assistant workflow boots a fresh container. Override
// via env in tests / staging to shrink the wait.
export const ASSISTANT_JOIN_WAIT_BUDGET_MS = parsePositiveInt(
  process.env.ASSISTANT_JOIN_WAIT_BUDGET_MS,
  25_000,
);
export const ASSISTANT_JOIN_POLL_INTERVAL_MS = parsePositiveInt(
  process.env.ASSISTANT_JOIN_POLL_INTERVAL_MS,
  1_500,
);

// Operational invariant: the stuck-row sweep must allow the in-process
// timeout to win under normal operation. If a misconfiguration inverts
// these (e.g. STUCK_THRESHOLD=60s + EXECUTOR_TIMEOUT=5min), the sweep
// would fire on live generations and mark them `failed` while the
// executor is still working. Fail fast at startup rather than silently
// corrupting generation state.
if (GENERATION_STUCK_SWEEP_THRESHOLD_MS <= GENERATION_EXECUTOR_TIMEOUT_MS) {
  throw new Error(
    `Configuration error: GENERATION_STUCK_SWEEP_THRESHOLD_MS (${GENERATION_STUCK_SWEEP_THRESHOLD_MS}ms) must be greater than GENERATION_EXECUTOR_TIMEOUT_MS (${GENERATION_EXECUTOR_TIMEOUT_MS}ms).`,
  );
}

// Telemetry proxy (client metrics → Datadog Agent OTLP receiver)
export const OTLP_METRICS_FORWARD_URL =
  process.env.OTLP_METRICS_FORWARD_URL?.trim() ||
  "http://localhost:4318/v1/metrics";
export const OTLP_TRACES_FORWARD_URL =
  process.env.OTLP_TRACES_FORWARD_URL?.trim() ||
  "http://localhost:4318/v1/traces";

// Datadog rejects points >1h old; drop at 55min to leave forwarding headroom.
export const TELEMETRY_MAX_POINT_AGE_MS = 55 * 60 * 1000;

// Max request body size for telemetry batches (bytes).
export const TELEMETRY_MAX_BODY_BYTES = 262_144; // 256 KiB

// Metric names must start with one of these prefixes.
export const TELEMETRY_METRIC_PREFIXES = [
  "xmtp.",
  "api.",
  "agent.",
  "core.",
  "inbox.",
  "network.",
  "sync.",
  "message.",
  "push.",
  "worker.",
  "session.",
  "storage.",
  "stream.",
] as const;

// Resource attributes allowed through (cardinality policy: nothing
// device-unique). Unknown keys are stripped, not rejected.
export const TELEMETRY_ALLOWED_RESOURCE_ATTRS = new Set([
  "service.name",
  "service.version",
  "deployment.environment",
  "convos.flavor",
  "os.version",
  "device.model",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
]);

// Data point attributes allowed through (same cardinality/PII policy as
// resource attrs — they become Datadog metric tags). "key" is the client
// meter sub-dimension (e.g. stream.content_type key=text/plain); values are
// app-enumerated, never user data.
// Note: only attribute KEYS are enforced here — value-level cardinality/PII
// discipline is the client's responsibility; review any new `key` call site
// against the cardinality policy before shipping.
export const TELEMETRY_ALLOWED_POINT_ATTRS = new Set<string>(["key"]);

// How long dedup rows are kept (covers client retry horizon).
export const TELEMETRY_BATCH_TTL_MS = 48 * 60 * 60 * 1000;
