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

export const auditRecentQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(512).optional(),
  action: z.enum(["all", "grant", "adjust"]).default("all"),
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

const accountsPageLimit = {
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

export const accountsListQuerySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("balance"),
    min: z.coerce.number().int().optional(),
    max: z.coerce.number().int().optional(),
    sort: z.enum(["asc", "desc"]).default("desc"),
    ...accountsPageLimit,
  }),
  z.object({
    mode: z.literal("broken"),
    maxBalance: z.coerce.number().int().default(0),
    ...accountsPageLimit,
  }),
  z.object({
    mode: z.literal("grantKind"),
    kind: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/),
    ...accountsPageLimit,
  }),
  z.object({
    mode: z.literal("activity"),
    state: z.enum(["active", "dormant"]),
    days: z.coerce.number().int().min(1).max(365).default(30),
    ...accountsPageLimit,
  }),
]);
