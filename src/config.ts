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

// Agent pool (optional — endpoint returns 503 if not configured)
export const AGENT_POOL_URL = process.env.AGENT_POOL_URL || "";
export const AGENT_POOL_API_KEY = process.env.AGENT_POOL_API_KEY || "";

// Agent asset upload auth (optional — endpoint returns 503 if not configured)
export const AGENT_ASSETS_API_KEY = process.env.AGENT_ASSETS_API_KEY || "";

// Composio (optional — /v2/connections/* endpoints return 503 if not configured).
// Auth configs are resolved dynamically from Composio by toolkit slug; no local mapping.
export const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || "";
export const COMPOSIO_CONNECTION_CALLBACK_URL =
  process.env.COMPOSIO_CONNECTION_CALLBACK_URL ||
  "convos://connections/callback";

export const XMTP_ENV = process.env.XMTP_ENV || "dev";

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
export const CONTENT_MODERATION_MODEL =
  process.env.CONTENT_MODERATION_MODEL?.trim() ||
  "anthropic/claude-3-5-haiku-20241022";
export const EXA_SERVICE_KEY = process.env.EXA_SERVICE_KEY?.trim() || "";

// Twitter integration (optional — moderation/reply paths only fire when
// twitterContext is present on a generation; defaults match the content
// moderation model so a single env var change can pin everything to one
// model if desired).
export const TWITTER_MODERATION_MODEL =
  process.env.TWITTER_MODERATION_MODEL?.trim() ||
  "anthropic/claude-3-5-haiku-20241022";
export const TWITTER_REPLY_MODEL =
  process.env.TWITTER_REPLY_MODEL?.trim() ||
  "anthropic/claude-3-5-haiku-20241022";
export const TEMPLATE_SITE_URL =
  process.env.TEMPLATE_SITE_URL?.trim() || "https://convos.org/assistants";

// PostHog metering (optional — capture is no-op if either is unset).
export const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY?.trim() || "";
export const POSTHOG_HOST = process.env.POSTHOG_HOST?.trim() || "";

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
