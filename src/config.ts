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
