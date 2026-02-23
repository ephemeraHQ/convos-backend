import { z } from "zod";

export const DEVICE_ID_MAX_LENGTH = 128;

/**
 * Device IDs are platform-defined opaque identifiers.
 *
 * iOS: identifierForVendor (UUID-like)
 * Android: ANDROID_ID (hex) or Firebase Installation ID (base64url-like)
 */
export const deviceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(DEVICE_ID_MAX_LENGTH);
