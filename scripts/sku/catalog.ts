import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SubscriptionPeriod } from "@prisma/client";
import { parse } from "yaml";
import { z } from "zod";
import { productMapping } from "@/subscriptions/product-mapping";
import { SUBSCRIPTION_TIERS } from "@/subscriptions/tiers";
import type { Catalog, DesiredProduct } from "./types";

const localizationSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

const googleSchema = z
  .object({
    basePlanId: z.string().min(1),
    billingPeriod: z.string().regex(/^P\d+[DWMY]$/, {
      message: "billingPeriod must be ISO-8601 duration like P1M or P1Y",
    }),
    // The Android Publisher API requires exactly one of
    // autoRenewingBasePlanType / prepaidBasePlanType / installmentsBasePlanType
    // on a BasePlan. We only emit autoRenewingBasePlanType, so reject
    // autoRenewingPlan: false until prepaid/installments support is added.
    autoRenewingPlan: z.literal(true, {
      errorMap: () => ({
        message:
          "autoRenewingPlan: false is not supported. Add prepaid/installments BasePlan payload generation to scripts/sku/google-play-catalog.ts first.",
      }),
    }),
  })
  .strict();

const productSchema = z
  .object({
    tier: z.enum(SUBSCRIPTION_TIERS),
    period: z.nativeEnum(SubscriptionPeriod),
    productId: z.string().min(1),
    referenceName: z.string().min(1).max(64),
    localizations: z.record(z.string(), localizationSchema),
    pricing: z.record(z.string().length(3), z.number().int().nonnegative()),
    google: googleSchema,
  })
  .strict()
  .superRefine((p, ctx) => {
    // productId must match the runtime regex AND match the declared tier/period.
    let mapped;
    try {
      mapped = productMapping(p.productId);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productId"],
        message:
          err instanceof Error
            ? err.message
            : `Invalid productId ${p.productId}`,
      });
      return;
    }
    if (mapped.period !== p.period) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["period"],
        message: `period "${p.period}" disagrees with productId period "${mapped.period}"`,
      });
    }
    if (!("en-US" in p.localizations)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["localizations"],
        message: "en-US localization is required",
      });
    }
    if (!("USD" in p.pricing)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pricing"],
        message: "USD price is required",
      });
    }
  });

const catalogSchema = z
  .object({
    subscriptionGroupReferenceName: z.string().min(1),
    products: z.array(productSchema).min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.products.forEach((p, i) => {
      if (seen.has(p.productId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["products", i, "productId"],
          message: `Duplicate productId: ${p.productId}`,
        });
      }
      seen.add(p.productId);
    });
  });

export const DEFAULT_CATALOG_PATH = resolve(
  process.cwd(),
  "config/subscriptions.catalog.yaml",
);

export const loadCatalogFromString = (raw: string): Catalog => {
  const parsed = parse(raw) as unknown;
  return catalogSchema.parse(parsed);
};

export const loadCatalog = (path: string = DEFAULT_CATALOG_PATH): Catalog =>
  loadCatalogFromString(readFileSync(path, "utf-8"));

export const findProduct = (
  catalog: Catalog,
  productId: string,
): DesiredProduct | null =>
  catalog.products.find((p) => p.productId === productId) ?? null;
