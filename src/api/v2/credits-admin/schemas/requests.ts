import { z } from "zod";
import { idempotencyKeySchema } from "@/payments/ledger/idempotency-key";
import { accountIdSchema } from "@/utils/account-id";

export const MAX_ADMIN_GRANT_CREDITS = 100_000_000;

export const searchQuerySchema = z.object({
  key: z.enum(["accountId", "wallet"]),
  value: z.string().trim().min(1).max(256),
});

export const auditQuerySchema = z.object({
  accountId: accountIdSchema,
});

export const grantBodySchema = z.object({
  credits: z.number().int().positive().max(MAX_ADMIN_GRANT_CREDITS),
  reason: z.string().trim().min(1).max(256),
  idempotencyKey: idempotencyKeySchema,
});

export const adjustBodySchema = z.object({
  delta: z
    .number()
    .int()
    .refine((v) => v !== 0, { message: "delta_must_be_nonzero" })
    .refine((v) => Math.abs(v) <= MAX_ADMIN_GRANT_CREDITS, {
      message: "delta_out_of_range",
    }),
  reason: z.string().trim().min(1).max(256),
  idempotencyKey: idempotencyKeySchema,
});
