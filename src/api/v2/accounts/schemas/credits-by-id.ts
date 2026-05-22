import { z } from "zod";
import {
  MAX_GRANT_CREDITS,
  MAX_USD_COST_MICROS,
  bigintStringOrNumber,
} from "./shared";

// Path params for /v2/accounts/:accountId/credits/*
export const accountIdParamSchema = z.object({
  accountId: z.string().uuid({ message: "invalid_account_id" }),
});

// POST /v2/accounts/:accountId/credits/transactions request body
export const transactionRequestSchema = z.object({
  usdCostMicros: bigintStringOrNumber.refine(
    (v) => v >= 0n && v <= MAX_USD_COST_MICROS,
    { message: "usdCostMicros out of range" },
  ),
  requestId: z.string().min(1),
  model: z.string().optional(),
});
export type TransactionRequest = z.infer<typeof transactionRequestSchema>;

// POST /v2/accounts/:accountId/credits/grants request body
export const grantRequestSchema = z.object({
  grantKind: z.enum(["signup_bonus", "daily_refill", "manual"]),
  creditsDelta: z.number().int().positive().max(MAX_GRANT_CREDITS),
  reason: z.string().optional(),
});
export type GrantRequest = z.infer<typeof grantRequestSchema>;
