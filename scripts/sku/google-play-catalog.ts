import { google, type androidpublisher_v3 } from "googleapis";
import type {
  DesiredProduct,
  DiffOp,
  Locale,
  Pricing,
  RemoteGoogleProduct,
  StoreDiff,
} from "./types";

const requireEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

/**
 * Loads the JSON for the deploy-time service account. Falls back to the
 * runtime var so a single elevated service account works out of the box.
 */
const loadCredentials = (): Record<string, unknown> => {
  const raw =
    process.env.GOOGLE_PLAY_DEPLOY_SERVICE_ACCOUNT_JSON?.trim() ||
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) {
    throw new Error(
      "Missing GOOGLE_PLAY_DEPLOY_SERVICE_ACCOUNT_JSON (or fallback GOOGLE_PLAY_SERVICE_ACCOUNT_JSON)",
    );
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `GOOGLE_PLAY_DEPLOY_SERVICE_ACCOUNT_JSON is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
};

let cachedClient: androidpublisher_v3.Androidpublisher | null = null;
let cachedPackageName: string | null = null;

const getClient = () => {
  if (cachedClient && cachedPackageName) {
    return { client: cachedClient, packageName: cachedPackageName };
  }
  const packageName = requireEnv("GOOGLE_PLAY_PACKAGE_NAME");
  const credentials = loadCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  cachedClient = google.androidpublisher({ version: "v3", auth });
  cachedPackageName = packageName;
  return { client: cachedClient, packageName };
};

export const resetGooglePlayCatalogForTests = () => {
  cachedClient = null;
  cachedPackageName = null;
};

const minorUnitsToMoney = (
  currency: string,
  minorUnits: number,
): androidpublisher_v3.Schema$Money => {
  // Google's Money: { units (whole), nanos (1e9-scaled fractional) }. We
  // assume two decimal places (good enough for the currencies in the
  // catalog today; revisit if we add zero-decimal currencies like JPY).
  const sign = minorUnits < 0 ? -1 : 1;
  const abs = Math.abs(minorUnits);
  const wholeUnits = Math.trunc(abs / 100);
  const remainderCents = abs % 100;
  return {
    currencyCode: currency,
    units: String(sign * wholeUnits),
    nanos: sign * remainderCents * 10_000_000,
  };
};

const moneyToMinorUnits = (
  money: androidpublisher_v3.Schema$Money | undefined,
): number | null => {
  if (!money) return null;
  const units = Number(money.units ?? "0");
  const nanos = money.nanos ?? 0;
  // round to nearest cent
  return Math.round(units * 100 + nanos / 10_000_000);
};

const isNotFound = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: number; status?: number }).code;
  const status = (err as { status?: number }).status;
  return code === 404 || status === 404;
};

export const fetchRemote = async (
  productId: string,
): Promise<RemoteGoogleProduct> => {
  const { client, packageName } = getClient();
  let sub: androidpublisher_v3.Schema$Subscription;
  try {
    const res = await client.monetization.subscriptions.get({
      packageName,
      productId,
    });
    sub = res.data;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }

  const localizations: Record<Locale, { name: string; description: string }> =
    {};
  for (const l of sub.listings ?? []) {
    if (!l.languageCode) continue;
    localizations[l.languageCode] = {
      name: l.title ?? "",
      description:
        l.benefits?.join("\n") ||
        (l as { description?: string }).description ||
        "",
    };
  }

  const basePlansList = sub.basePlans ?? [];
  const basePlanRaw = basePlansList.at(0);
  let basePlan: NonNullable<RemoteGoogleProduct>["basePlan"] = null;
  if (basePlanRaw !== undefined) {
    const regional: Pricing = {};
    for (const rp of basePlanRaw.regionalConfigs ?? []) {
      const price = rp.price ?? undefined;
      const minor = moneyToMinorUnits(price);
      if (price?.currencyCode && minor !== null) {
        regional[price.currencyCode] = minor;
      }
    }
    basePlan = {
      basePlanId: basePlanRaw.basePlanId ?? "",
      billingPeriod:
        basePlanRaw.autoRenewingBasePlanType?.billingPeriodDuration ?? "",
      autoRenewingPlan: Boolean(basePlanRaw.autoRenewingBasePlanType),
      state:
        (basePlanRaw.state as "DRAFT" | "ACTIVE" | "INACTIVE" | undefined) ??
        "UNKNOWN",
      regionalPrices: regional,
    };
  }

  return {
    productId,
    localizations,
    basePlan,
  };
};

export const computeDiff = (
  desired: DesiredProduct,
  remote: RemoteGoogleProduct,
): StoreDiff => {
  const ops: DiffOp[] = [];

  if (!remote) {
    ops.push({
      kind: "create",
      field: "subscription",
      value: desired.productId,
    });
  }

  // Localizations: add or update each entry; ignore extras (drift may be
  // intentional, e.g. a locale added by hand for a market we haven't
  // codified yet). Adopt-only semantics keep the script safe.
  const remoteLocs = remote?.localizations ?? {};
  for (const [locale, desiredLoc] of Object.entries(desired.localizations)) {
    if (!(locale in remoteLocs)) {
      ops.push({
        kind: "create",
        field: `localizations.${locale}`,
        value: desiredLoc,
      });
      continue;
    }
    const cur = remoteLocs[locale];
    if (cur.name !== desiredLoc.name) {
      ops.push({
        kind: "update",
        field: `localizations.${locale}.name`,
        from: cur.name,
        to: desiredLoc.name,
      });
    }
    if (cur.description !== desiredLoc.description) {
      ops.push({
        kind: "update",
        field: `localizations.${locale}.description`,
        from: cur.description,
        to: desiredLoc.description,
      });
    }
  }

  // Base plan
  const desiredBp = desired.google;
  const currentBp = remote?.basePlan ?? null;
  if (!currentBp) {
    ops.push({ kind: "create", field: "basePlan", value: desiredBp });
  } else {
    if (currentBp.basePlanId !== desiredBp.basePlanId) {
      ops.push({
        kind: "update",
        field: "basePlan.basePlanId",
        from: currentBp.basePlanId,
        to: desiredBp.basePlanId,
      });
    }
    if (currentBp.billingPeriod !== desiredBp.billingPeriod) {
      ops.push({
        kind: "update",
        field: "basePlan.billingPeriod",
        from: currentBp.billingPeriod,
        to: desiredBp.billingPeriod,
      });
    }
    if (currentBp.autoRenewingPlan !== desiredBp.autoRenewingPlan) {
      ops.push({
        kind: "update",
        field: "basePlan.autoRenewingPlan",
        from: currentBp.autoRenewingPlan,
        to: desiredBp.autoRenewingPlan,
      });
    }
  }

  // Prices on the base plan
  const currentPrices = currentBp?.regionalPrices ?? {};
  for (const [currency, desiredMinor] of Object.entries(desired.pricing)) {
    if (!(currency in currentPrices)) {
      ops.push({
        kind: "create",
        field: `basePlan.regionalPrices.${currency}`,
        value: desiredMinor,
      });
      continue;
    }
    const cur = currentPrices[currency];
    if (cur !== desiredMinor) {
      ops.push({
        kind: "update",
        field: `basePlan.regionalPrices.${currency}`,
        from: cur,
        to: desiredMinor,
      });
    }
  }

  return { store: "google", productId: desired.productId, ops };
};

/**
 * Apply a diff. Base plans are managed as part of the parent Subscription
 * resource in the Play monetization v3 API — there are no `basePlans.create`
 * or `basePlans.patch` endpoints. We pass the full `basePlans` array through
 * `subscriptions.create` / `subscriptions.patch` with the relevant update
 * mask. After patching, we call `basePlans.activate` if the plan isn't
 * already active.
 */
export const apply = async (
  desired: DesiredProduct,
  remote: RemoteGoogleProduct,
): Promise<number> => {
  const { client, packageName } = getClient();
  let applied = 0;

  const listings: androidpublisher_v3.Schema$SubscriptionListing[] =
    Object.entries(desired.localizations).map(([locale, loc]) => ({
      languageCode: locale,
      title: loc.name,
      benefits: [],
      description: loc.description,
    }));

  const regionalConfigs: androidpublisher_v3.Schema$RegionalBasePlanConfig[] =
    Object.entries(desired.pricing).map(([currency, minor]) => ({
      regionCode: currencyToRegion(currency),
      newSubscriberAvailability: true,
      price: minorUnitsToMoney(currency, minor),
    }));

  const basePlan: androidpublisher_v3.Schema$BasePlan = {
    basePlanId: desired.google.basePlanId,
    state: "ACTIVE",
    regionalConfigs,
    ...(desired.google.autoRenewingPlan
      ? {
          autoRenewingBasePlanType: {
            billingPeriodDuration: desired.google.billingPeriod,
            resubscribeState: "RESUBSCRIBE_STATE_ACTIVE",
            prorationMode:
              "SUBSCRIPTION_PRORATION_MODE_CHARGE_ON_NEXT_BILLING_DATE",
            legacyCompatible: false,
          },
        }
      : {}),
  };

  if (!remote) {
    await client.monetization.subscriptions.create({
      packageName,
      productId: desired.productId,
      requestBody: {
        productId: desired.productId,
        listings,
        basePlans: [basePlan],
        taxAndComplianceSettings: {
          eeaWithdrawalRightType: "WITHDRAWAL_RIGHT_SERVICE",
        },
      },
    });
    applied += 1;
  } else {
    await client.monetization.subscriptions.patch({
      packageName,
      productId: desired.productId,
      updateMask: "listings,basePlans",
      requestBody: {
        productId: desired.productId,
        listings,
        basePlans: [basePlan],
      },
    });
    applied += 1;
    // Patch leaves the plan in DRAFT if it was previously inactive. Force
    // ACTIVE so new buyers see the price.
    if (remote.basePlan?.state !== "ACTIVE") {
      await client.monetization.subscriptions.basePlans.activate({
        packageName,
        productId: desired.productId,
        basePlanId: desired.google.basePlanId,
      });
      applied += 1;
    }
  }

  return applied;
};

// Naive currency → region. Google's regionalConfigs takes region codes
// (US, GB, DE, ...), not currency codes. Maps the currencies in our
// catalog today; expand alongside the catalog.
const currencyToRegion = (currency: string): string => {
  switch (currency) {
    case "USD":
      return "US";
    case "EUR":
      return "DE"; // EUR is region-priced; DE is a common anchor
    case "GBP":
      return "GB";
    default:
      throw new Error(
        `No currency→region mapping defined for ${currency}; add it to scripts/sku/google-play-catalog.ts`,
      );
  }
};
