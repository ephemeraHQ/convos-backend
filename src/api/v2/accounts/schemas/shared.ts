import { z } from "zod";

export { idempotencyKeySchema } from "@/payments/ledger/idempotency-key";

// Per-call cost cap. $1000/call in USD micros. Preserved from the original
// credits.router.ts schemas to keep request-size sanity bounds in place.
export const MAX_USD_COST_MICROS = 1_000_000_000n;

// Per-grant credits cap. 1B credits. Fits comfortably under Number.MAX_SAFE_INTEGER.
export const MAX_GRANT_CREDITS = 1_000_000_000;

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
