import { z } from "zod";

// Per-call cost cap. $1000/call in USD micros. Preserved from the original
// credits.router.ts schemas to keep request-size sanity bounds in place.
export const MAX_USD_COST_MICROS = 1_000_000_000n;

// Per-grant credits cap. 1B credits. Fits comfortably under Number.MAX_SAFE_INTEGER.
export const MAX_GRANT_CREDITS = 1_000_000_000;

// Stripe-style idempotency key: ASCII alphanumeric + dash/underscore, 1-255 chars.
export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_\-]{1,255}$/, {
    message: "invalid_idempotency_key",
  });

// BigInt-safe integer parser: accepts string or number, returns bigint.
export const bigintStringOrNumber = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      return BigInt(v);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a BigInt-safe integer",
      });
      return z.NEVER;
    }
  });
