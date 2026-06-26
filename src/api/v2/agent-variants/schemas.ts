import { z } from "zod";

// Variant lifecycle. Plain-string column in Prisma (no Postgres enum); this is
// the single source of valid values, validated on write and used by the GET
// filter. building → ready/failed as CI deploys; stale is reserved for a future
// reconciler.
export const AGENT_VARIANT_STATUSES = [
  "building",
  "ready",
  "failed",
  "stale",
] as const;
export const AgentVariantStatusSchema = z.enum(AGENT_VARIANT_STATUSES);
export type AgentVariantStatus = z.infer<typeof AgentVariantStatusSchema>;

// Write body for POST /v2/agent-variants. Server-to-server only (the variant CI
// holds the scoped registry token), so `.strict()` is safe here — this is NOT a
// shipped-client contract. `slug` is the natural key; an upsert keys on it.
export const AgentVariantUpsertSchema = z
  .object({
    // PR slug, e.g. "pr-1234" → ephemeral-pr-1234.convos.fun.
    slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(
        /^[a-z0-9-]+$/,
        "slug must be lowercase alphanumerics and hyphens",
      ),
    label: z.string().trim().min(1).max(40),
    whatToTest: z.string().trim().min(1).max(500),
    // Optional, NOT defaulted: an omitted field stays `undefined` so a partial
    // re-POST (the upsert spreads `...rest` into the Prisma `update`) preserves
    // the stored value instead of clobbering it with a default. Omitted fields
    // on create fall back to the Prisma column defaults (`status` → "building",
    // the nullable URL/slug/date columns → null).
    status: AgentVariantStatusSchema.optional(),
    // The ephemeral runtime base URL, or null for the default dev runtime.
    assistantWorkerUrl: z.string().url().nullable().optional(),
    // A bench/Braintrust prompt slug, or null for the canonical generator.
    builderPromptSlug: z.string().trim().min(1).nullable().optional(),
    prUrl: z.string().url(),
    branch: z.string().trim().min(1).max(255),
    commit: z.string().trim().min(1).max(64),
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict();
export type AgentVariantUpsert = z.infer<typeof AgentVariantUpsertSchema>;
