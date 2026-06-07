import { z } from "zod";
import { USAGE_BUCKETS } from "@/payments/credits/usage-window";
import {
  bigintStringOrNumber,
  MAX_GRANT_CREDITS,
  MAX_USD_COST_MICROS,
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
  requestId: z.string().trim().min(1).max(256),
  // model + reason are logged via req.log.info and persisted on the ledger row.
  // .trim() normalises whitespace; .max(256) caps log/storage pressure from a
  // misbehaving or compromised caller. Limit chosen generously vs Stripe's
  // 500-char description field but small enough to keep log lines bounded.
  model: z.string().trim().max(256).optional(),
});
export type TransactionRequest = z.infer<typeof transactionRequestSchema>;

// POST /v2/accounts/:accountId/credits/grants request body
export const grantRequestSchema = z.object({
  grantKind: z.enum(["signup_bonus", "daily_refill", "manual"]),
  creditsDelta: z.number().int().positive().max(MAX_GRANT_CREDITS),
  reason: z.string().trim().max(256).optional(),
});
export type GrantRequest = z.infer<typeof grantRequestSchema>;

// Widest usage window. A year bounds the zero-fill loop + query scan and is
// plenty for a spend chart at any bucket granularity.
export const MAX_USAGE_DAYS = 365;

// GET /v2/accounts/:accountId/credits/usage?days=N&bucket=day|week|month query
// params. Both arrive as strings; coerce + default to a 30-day, day-bucketed
// window.
export const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(MAX_USAGE_DAYS).default(30),
  bucket: z.enum(USAGE_BUCKETS).default("day"),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;
