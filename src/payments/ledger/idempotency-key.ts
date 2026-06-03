import { z } from "zod";
import { ValidationError } from "@/utils/errors";

// Stripe-style idempotency key: ASCII alphanumeric + dash/underscore, 1-255 chars.
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{1,255}$/;

export const idempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_REGEX, {
  message: "invalid_idempotency_key",
});

export const assertIdempotencyKey = (key: string): void => {
  if (!IDEMPOTENCY_KEY_REGEX.test(key)) {
    throw new ValidationError(`invalid_idempotency_key: ${key}`);
  }
};
