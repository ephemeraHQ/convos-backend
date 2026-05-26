import type { SubscriptionPeriod } from "@prisma/client";
import type { SubscriptionTier } from "@/subscriptions/tiers";

export type Locale = string; // BCP-47, e.g. "en-US"

export type Localization = {
  name: string;
  description: string;
};

export type Pricing = Record<string, number>; // ISO 4217 currency → minor units (cents)

export type GoogleBasePlan = {
  basePlanId: string;
  billingPeriod: string; // ISO-8601 duration, e.g. "P1M"
  autoRenewingPlan: boolean;
};

export type DesiredProduct = {
  tier: SubscriptionTier;
  period: SubscriptionPeriod;
  productId: string;
  referenceName: string;
  localizations: Record<Locale, Localization>;
  pricing: Pricing;
  google: GoogleBasePlan;
};

export type Catalog = {
  subscriptionGroupReferenceName: string;
  products: DesiredProduct[];
};

// --- Remote state snapshots (what we read back from each store) ----------

export type RemoteGoogleProduct = {
  productId: string;
  localizations: Record<Locale, Localization>;
  basePlan: {
    basePlanId: string;
    billingPeriod: string;
    autoRenewingPlan: boolean;
    state: "DRAFT" | "ACTIVE" | "INACTIVE" | "UNKNOWN";
    regionalPrices: Pricing; // ISO currency → minor units
  } | null;
} | null;

export type RemoteAppleProduct = {
  id: string; // Apple's internal subscription id
  productId: string;
  referenceName: string;
  state: string; // WAITING_FOR_REVIEW | APPROVED | DEVELOPER_REMOVED_FROM_SALE | ...
  subscriptionPeriod: string; // ONE_MONTH | ONE_YEAR | ...
  localizations: Record<
    Locale,
    { id: string; name: string; description: string }
  >;
  // Currency → { pricePointId, customerPriceMinorUnits }. Resolved per
  // territory when we set prices.
  prices: Record<
    string,
    { pricePointId: string | null; minorUnits: number | null }
  >;
} | null;

// --- Diff shapes --------------------------------------------------------

export type DiffOp =
  | { kind: "create"; field: string; value: unknown }
  | {
      kind: "update";
      field: string;
      from: unknown;
      to: unknown;
    };

export type StoreDiff = {
  store: "apple" | "google";
  productId: string;
  ops: DiffOp[];
  // Apple-only: true when this product doesn't exist remotely yet. Creating
  // a new Apple sub requires --allow-create + an App Review submission.
  isAppleCreate?: boolean;
};

export type ProductDiff = {
  productId: string;
  apple: StoreDiff | null;
  google: StoreDiff | null;
};

export type ApplyResult = {
  productId: string;
  store: "apple" | "google";
  ok: boolean;
  errorMessage?: string;
  appliedOps: number;
};
