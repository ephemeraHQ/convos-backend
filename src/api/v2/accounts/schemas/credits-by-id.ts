import { z } from "zod";

/** Validated :accountId path param (UUID shape guaranteed by meGuard upstream). */
export const accountIdParamSchema = z.object({
  accountId: z.string().uuid(),
});

const MAX_USD_COST_MICROS = 1_000_000_000n; // $1000 per call ceiling

/**
 * bigintStringOrNumber — accepts string or number, coerces to BigInt.
 * Mirrors the existing pattern in src/api/v2/credits/schemas.ts.
 */
const bigintStringOrNumber = z
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

/** Body schema for POST /v2/accounts/:accountId/credits/transactions */
export const transactionRequestSchema = z.object({
  usdCostMicros: bigintStringOrNumber.refine(
    (v) => v >= 0n && v <= MAX_USD_COST_MICROS,
    { message: "usdCostMicros out of range [0, 1_000_000_000]" },
  ),
  requestId: z.string().min(1),
  model: z.string().optional(),
});
export type TransactionRequest = z.infer<typeof transactionRequestSchema>;
