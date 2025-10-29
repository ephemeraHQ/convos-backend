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

// v1 JWT (kept for backward compatibility with v1 auth endpoints)
if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not configured");
}

if (!process.env.JWT_PRIVATE_KEY) {
  throw new Error("JWT_PRIVATE_KEY is not configured");
}

if (!process.env.JWT_PUBLIC_KEY) {
  throw new Error("JWT_PUBLIC_KEY is not configured");
}

if (!process.env.NOTIFICATION_SERVER_URL) {
  throw new Error("NOTIFICATION_SERVER_URL is not configured");
}

// Cache environment variables
export const XMTP_NOTIFICATION_SECRET = process.env.XMTP_NOTIFICATION_SECRET;

// v1 JWT (legacy - symmetric HS256)
export const JWT_SECRET = process.env.JWT_SECRET;

// Validate JWT_SECRET is a non-empty string before encoding
if (typeof JWT_SECRET !== "string" || JWT_SECRET.trim().length === 0) {
  throw new Error(
    "Missing `JWT_SECRET`: set a non-empty string in environment before starting the app",
  );
}
export const JWT_SECRET_BYTES = new TextEncoder().encode(JWT_SECRET);

// V2 JWT (asymmetric ECDSA ES256)
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
