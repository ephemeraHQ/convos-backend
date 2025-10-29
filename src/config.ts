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

// v1 JWT (legacy - symmetric HS256, optional for backward compatibility)
// Only validate and encode if JWT_SECRET is provided
export const JWT_SECRET = process.env.JWT_SECRET;
export const JWT_SECRET_BYTES = JWT_SECRET
  ? new TextEncoder().encode(JWT_SECRET)
  : undefined;

// v2 JWT (asymmetric ECDSA ES256)
const JWT_PRIVATE_KEY_RAW = process.env.JWT_PRIVATE_KEY;
const JWT_PUBLIC_KEY_RAW = process.env.JWT_PUBLIC_KEY;

// Validate JWT_PRIVATE_KEY is a non-empty string
if (
  typeof JWT_PRIVATE_KEY_RAW !== "string" ||
  JWT_PRIVATE_KEY_RAW.trim().length === 0
) {
  throw new Error(
    "Missing `JWT_PRIVATE_KEY`: set a non-empty PEM-encoded ECDSA private key in environment before starting the app",
  );
}

// Validate JWT_PUBLIC_KEY is a non-empty string
if (
  typeof JWT_PUBLIC_KEY_RAW !== "string" ||
  JWT_PUBLIC_KEY_RAW.trim().length === 0
) {
  throw new Error(
    "Missing `JWT_PUBLIC_KEY`: set a non-empty PEM-encoded ECDSA public key in environment before starting the app",
  );
}

// Export as non-null strings after validation
export const JWT_PRIVATE_KEY: string = JWT_PRIVATE_KEY_RAW;
export const JWT_PUBLIC_KEY: string = JWT_PUBLIC_KEY_RAW;

export const JWT_ISSUER = "convos.org";
export const NOTIFICATION_SERVER_URL = process.env.NOTIFICATION_SERVER_URL;
export const NODE_ENV = process.env.NODE_ENV || "development";
export const IS_PRODUCTION = process.env.NODE_ENV === "production";
export const IS_DEVELOPMENT = process.env.NODE_ENV === "development";
