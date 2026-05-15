import { z } from "zod";

export const checkRequestSchema = z.object({
  accountId: z.string().uuid(),
});
export type CheckRequest = z.infer<typeof checkRequestSchema>;

// Reused by consume + grant in later tasks.
const bigintStringOrNumber = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      const b = BigInt(v);
      return b;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a BigInt-safe integer",
      });
      return z.NEVER;
    }
  });

const MAX_USD_COST_MICROS = 1_000_000_000n; // $1000 per call

export const consumeRequestSchema = z.object({
  accountId: z.string().uuid(),
  usdCostMicros: bigintStringOrNumber.refine(
    (v) => v >= 0n && v <= MAX_USD_COST_MICROS,
    { message: "usdCostMicros out of range" },
  ),
  idempotencyKey: z.string().min(1),
  requestId: z.string().min(1),
  model: z.string().optional(),
});
export type ConsumeRequest = z.infer<typeof consumeRequestSchema>;

const MAX_GRANT_CREDITS = 1_000_000_000;

export const grantRequestSchema = z.object({
  accountId: z.string().uuid(),
  credits: z.number().int().positive().max(MAX_GRANT_CREDITS),
  grantKindId: z.enum(["signup_bonus", "manual"]),
  idempotencyKey: z.string().min(1),
  note: z.string().optional(),
});
export type GrantRequest = z.infer<typeof grantRequestSchema>;
