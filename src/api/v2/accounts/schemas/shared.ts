import { z } from "zod";

/**
 * Stripe-style Idempotency-Key header validation.
 *
 * Rules (spec § 3.2):
 *  - 1–255 printable ASCII characters (0x21–0x7E, no whitespace or control chars)
 *  - Empty string → rejected (invalid_idempotency_key)
 *
 * The regex /^[\x21-\x7E]{1,255}$/ covers:
 *  - Minimum 1 char (rejects empty)
 *  - Maximum 255 chars
 *  - No whitespace (0x20), no control chars (0x00–0x1F, 0x7F)
 */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[\x21-\x7E]{1,255}$/, "invalid_idempotency_key");
