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

export const VALID_XMTP_ENVS = [
  "production",
  "testnet",
  "dev",
  "local",
] as const;
export type XmtpEnv = (typeof VALID_XMTP_ENVS)[number];

function isValidXmtpEnv(value: string): value is XmtpEnv {
  return (VALID_XMTP_ENVS as readonly string[]).includes(value);
}

export function parseXmtpEnv(value = process.env.XMTP_ENV || "dev"): XmtpEnv {
  if (!isValidXmtpEnv(value)) {
    throw new Error(
      `Invalid XMTP_ENV: ${value}. Must be one of: ${VALID_XMTP_ENVS.join(", ")}`,
    );
  }

  return value;
}

export const XMTP_ENV = parseXmtpEnv();

export function isXmtpProduction(xmtpEnv: XmtpEnv = XMTP_ENV): boolean {
  return xmtpEnv === "production";
}

export function shouldUseDevBehavior(xmtpEnv: XmtpEnv = XMTP_ENV): boolean {
  return !isXmtpProduction(xmtpEnv);
}
