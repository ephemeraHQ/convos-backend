import { SubscriptionPeriod } from "@prisma/client";
import { importPKCS8, SignJWT } from "jose";
import type {
  DesiredProduct,
  DiffOp,
  RemoteAppleProduct,
  StoreDiff,
} from "./types";

const API_BASE = "https://api.appstoreconnect.apple.com";
const TOKEN_TTL_SECONDS = 1200; // 20 minutes; Apple max is 20m

const loadCreds = () => ({
  keyId:
    process.env.APPLE_CONNECT_API_KEY_ID?.trim() ||
    process.env.APPLE_API_KEY_ID?.trim(),
  issuerId:
    process.env.APPLE_CONNECT_API_ISSUER_ID?.trim() ||
    process.env.APPLE_API_ISSUER_ID?.trim(),
  signingKey:
    process.env.APPLE_CONNECT_API_SIGNING_KEY?.trim() ||
    process.env.APPLE_API_SIGNING_KEY?.trim(),
  bundleId: process.env.APPLE_BUNDLE_ID?.trim(),
});

type Creds = {
  keyId: string;
  issuerId: string;
  signingKey: string;
  bundleId: string;
};

const requireCreds = (): Creds => {
  const c = loadCreds();
  const { keyId, issuerId, signingKey, bundleId } = c;
  if (!keyId || !issuerId || !signingKey || !bundleId) {
    const missing = Object.entries(c)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    throw new Error(
      `App Store Connect deploy creds missing: ${missing.join(", ")} (set APPLE_CONNECT_API_* or fall back to APPLE_API_*)`,
    );
  }
  return { keyId, issuerId, signingKey, bundleId };
};

let cachedToken: { token: string; expiresAt: number } | null = null;

const getToken = async (): Promise<string> => {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const { keyId, issuerId, signingKey } = requireCreds();
  const key = await importPKCS8(signingKey, "ES256");
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId, typ: "JWT" })
    .setIssuer(issuerId)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL_SECONDS)
    .setAudience("appstoreconnect-v1")
    .sign(key);
  cachedToken = { token, expiresAt: (now + TOKEN_TTL_SECONDS) * 1000 };
  return token;
};

export const resetAppleConnectForTests = () => {
  cachedToken = null;
  cachedAppId = null;
};

type Json = Record<string, unknown> | unknown[];

const apiFetch = async (
  path: string,
  init?: { method?: string; body?: Json; query?: Record<string, string> },
): Promise<unknown> => {
  const token = await getToken();
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 404) {
    throw new AppleConnectNotFound(`404 from ${url.pathname}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `App Store Connect ${res.status} ${res.statusText} for ${init?.method ?? "GET"} ${path}: ${text}`,
    );
  }
  if (res.status === 204) return null;
  return res.json();
};

export class AppleConnectNotFound extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AppleConnectNotFound";
  }
}

// --- App + Subscription Group resolution --------------------------------

let cachedAppId: string | null = null;

const getAppId = async (): Promise<string> => {
  if (cachedAppId) return cachedAppId;
  const { bundleId } = requireCreds();
  const data = (await apiFetch("/v1/apps", {
    query: { "filter[bundleId]": bundleId },
  })) as { data: Array<{ id: string }> };
  const app = data.data.at(0);
  if (!app) {
    throw new Error(`No App Store Connect app found for bundle id ${bundleId}`);
  }
  cachedAppId = app.id;
  return app.id;
};

export const findOrCreateSubscriptionGroup = async (
  referenceName: string,
): Promise<string> => {
  const appId = await getAppId();
  const list = (await apiFetch(`/v1/apps/${appId}/subscriptionGroups`)) as {
    data: Array<{ id: string; attributes: { referenceName: string } }>;
  };
  const existing = list.data.find(
    (g) => g.attributes.referenceName === referenceName,
  );
  if (existing) return existing.id;
  const created = (await apiFetch("/v1/subscriptionGroups", {
    method: "POST",
    body: {
      data: {
        type: "subscriptionGroups",
        attributes: { referenceName },
        relationships: {
          app: { data: { type: "apps", id: appId } },
        },
      },
    },
  })) as { data: { id: string } };
  return created.data.id;
};

const subscriptionPeriodApi = (period: SubscriptionPeriod): string =>
  period === SubscriptionPeriod.monthly ? "ONE_MONTH" : "ONE_YEAR";

// --- Read current state -------------------------------------------------

type AppleSubResource = {
  id: string;
  attributes: {
    productId: string;
    name: string;
    state: string;
    subscriptionPeriod: string;
  };
};

type AppleLocalizationResource = {
  id: string;
  attributes: {
    locale: string;
    name: string;
    description: string;
  };
};

export const fetchRemote = async (
  productId: string,
  subscriptionGroupId: string,
): Promise<RemoteAppleProduct> => {
  const list = (await apiFetch(
    `/v1/subscriptionGroups/${subscriptionGroupId}/subscriptions`,
    { query: { "filter[productId]": productId, limit: "200" } },
  )) as { data: AppleSubResource[] };
  const sub = list.data.at(0);
  if (!sub) return null;

  const locsRes = (await apiFetch(
    `/v1/subscriptions/${sub.id}/subscriptionLocalizations`,
  )) as { data: AppleLocalizationResource[] };

  const localizations: NonNullable<RemoteAppleProduct>["localizations"] = {};
  for (const l of locsRes.data) {
    localizations[l.attributes.locale] = {
      id: l.id,
      name: l.attributes.name,
      description: l.attributes.description,
    };
  }

  // Prices: list per-territory subscription prices, then map currency →
  // resolved price point minor units. We DO NOT resolve the catalog's
  // desired prices into price point ids here; that happens during apply
  // (one extra round trip per currency to /pricePoints).
  // Apple's relationship endpoint returns the linked pricePoint ids and we
  // include the included pricePoint resources to read customerPrice.
  const pricesRes = (await apiFetch(`/v1/subscriptions/${sub.id}/prices`, {
    query: { include: "subscriptionPricePoint", limit: "200" },
  })) as {
    data: Array<{
      id: string;
      relationships: {
        subscriptionPricePoint: { data: { id: string } };
      };
    }>;
    included?: Array<{
      id: string;
      type: string;
      attributes: { customerPrice: string; territory?: string };
      relationships: {
        territory: { data: { id: string } };
      };
    }>;
  };
  const includedById = new Map<
    string,
    { customerPrice: string; territoryId: string }
  >();
  for (const inc of pricesRes.included ?? []) {
    if (inc.type !== "subscriptionPricePoints") continue;
    includedById.set(inc.id, {
      customerPrice: inc.attributes.customerPrice,
      territoryId: inc.relationships.territory.data.id,
    });
  }
  // Apple territory ids are ISO country codes (USA, GBR, DEU, ...). We
  // map back to currency via the same table apply uses. To keep this read
  // path simple we record by territory id; the diff layer normalizes.
  const prices: NonNullable<RemoteAppleProduct>["prices"] = {};
  for (const p of pricesRes.data) {
    const ppId = p.relationships.subscriptionPricePoint.data.id;
    const meta = includedById.get(ppId);
    if (!meta) continue;
    const currency = territoryToCurrency(meta.territoryId);
    if (!currency) continue;
    const customerPriceMinor = Math.round(Number(meta.customerPrice) * 100);
    prices[currency] = {
      pricePointId: ppId,
      minorUnits: customerPriceMinor,
    };
  }

  return {
    id: sub.id,
    productId: sub.attributes.productId,
    referenceName: sub.attributes.name,
    state: sub.attributes.state,
    subscriptionPeriod: sub.attributes.subscriptionPeriod,
    localizations,
    prices,
  };
};

const currencyToTerritory = (currency: string): string => {
  switch (currency) {
    case "USD":
      return "USA";
    case "GBP":
      return "GBR";
    case "EUR":
      return "DEU"; // Anchor for EUR; Apple price points are per-territory
    default:
      throw new Error(
        `No currency→territory mapping defined for ${currency}; add it to scripts/sku/apple-connect.ts`,
      );
  }
};

const territoryToCurrency = (territory: string): string | null => {
  switch (territory) {
    case "USA":
      return "USD";
    case "GBR":
      return "GBP";
    case "DEU":
      return "EUR";
    default:
      return null;
  }
};

// --- Diff ---------------------------------------------------------------

export const computeDiff = (
  desired: DesiredProduct,
  remote: RemoteAppleProduct,
): StoreDiff => {
  const ops: DiffOp[] = [];
  if (!remote) {
    ops.push({
      kind: "create",
      field: "subscription",
      value: desired.productId,
    });
  } else {
    if (remote.referenceName !== desired.referenceName) {
      ops.push({
        kind: "update",
        field: "referenceName",
        from: remote.referenceName,
        to: desired.referenceName,
      });
    }
    const expectedPeriod = subscriptionPeriodApi(desired.period);
    if (remote.subscriptionPeriod !== expectedPeriod) {
      // Apple does not allow changing subscriptionPeriod after creation.
      // Flag it as an unreconcilable diff; reporter will surface it.
      ops.push({
        kind: "update",
        field: "subscriptionPeriod[!immutable]",
        from: remote.subscriptionPeriod,
        to: expectedPeriod,
      });
    }
  }

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

  const remotePrices = remote?.prices ?? {};
  for (const [currency, desiredMinor] of Object.entries(desired.pricing)) {
    if (!(currency in remotePrices)) {
      ops.push({
        kind: "create",
        field: `prices.${currency}`,
        value: desiredMinor,
      });
      continue;
    }
    const cur = remotePrices[currency];
    if (cur.minorUnits === null) {
      ops.push({
        kind: "create",
        field: `prices.${currency}`,
        value: desiredMinor,
      });
    } else if (cur.minorUnits !== desiredMinor) {
      ops.push({
        kind: "update",
        field: `prices.${currency}`,
        from: cur.minorUnits,
        to: desiredMinor,
      });
    }
  }

  return {
    store: "apple",
    productId: desired.productId,
    ops,
    isAppleCreate: !remote,
  };
};

// --- Apply --------------------------------------------------------------

type ApplyOptions = { allowCreate: boolean };

export const apply = async (
  desired: DesiredProduct,
  remote: RemoteAppleProduct,
  subscriptionGroupId: string,
  opts: ApplyOptions,
): Promise<number> => {
  let applied = 0;

  let subId: string;
  if (!remote) {
    if (!opts.allowCreate) {
      throw new Error(
        `Refusing to create Apple subscription ${desired.productId} without --allow-create. ` +
          `New Apple subscriptions require App Review submission before they activate.`,
      );
    }
    const created = (await apiFetch("/v1/subscriptions", {
      method: "POST",
      body: {
        data: {
          type: "subscriptions",
          attributes: {
            name: desired.referenceName,
            productId: desired.productId,
            subscriptionPeriod: subscriptionPeriodApi(desired.period),
            familySharable: false,
            groupLevel: 1,
          },
          relationships: {
            group: {
              data: { type: "subscriptionGroups", id: subscriptionGroupId },
            },
          },
        },
      },
    })) as { data: { id: string } };
    subId = created.data.id;
    applied += 1;
  } else {
    subId = remote.id;
    if (remote.referenceName !== desired.referenceName) {
      await apiFetch(`/v1/subscriptions/${subId}`, {
        method: "PATCH",
        body: {
          data: {
            type: "subscriptions",
            id: subId,
            attributes: { name: desired.referenceName },
          },
        },
      });
      applied += 1;
    }
  }

  // Localizations
  for (const [locale, loc] of Object.entries(desired.localizations)) {
    const cur = remote?.localizations[locale];
    if (!cur) {
      await apiFetch("/v1/subscriptionLocalizations", {
        method: "POST",
        body: {
          data: {
            type: "subscriptionLocalizations",
            attributes: {
              locale,
              name: loc.name,
              description: loc.description,
            },
            relationships: {
              subscription: { data: { type: "subscriptions", id: subId } },
            },
          },
        },
      });
      applied += 1;
    } else if (cur.name !== loc.name || cur.description !== loc.description) {
      await apiFetch(`/v1/subscriptionLocalizations/${cur.id}`, {
        method: "PATCH",
        body: {
          data: {
            type: "subscriptionLocalizations",
            id: cur.id,
            attributes: { name: loc.name, description: loc.description },
          },
        },
      });
      applied += 1;
    }
  }

  // Prices: resolve each desired currency's price point id, then POST a
  // subscriptionPrices link if missing or the customer price differs.
  for (const [currency, desiredMinor] of Object.entries(desired.pricing)) {
    const territory = currencyToTerritory(currency);
    const cur = remote?.prices[currency];
    if (cur && cur.minorUnits === desiredMinor) continue;
    const pricePointId = await resolvePricePoint(
      subId,
      territory,
      desiredMinor,
    );
    await apiFetch("/v1/subscriptionPrices", {
      method: "POST",
      body: {
        data: {
          type: "subscriptionPrices",
          relationships: {
            subscription: { data: { type: "subscriptions", id: subId } },
            subscriptionPricePoint: {
              data: { type: "subscriptionPricePoints", id: pricePointId },
            },
          },
        },
      },
    });
    applied += 1;
  }

  return applied;
};

/**
 * Resolve the opaque subscriptionPricePoint id for a desired (territory,
 * minor-units) pair. Apple exposes a paged list of allowed price points per
 * sub per territory; pick the one whose customerPrice rounds to our cents.
 */
const resolvePricePoint = async (
  subId: string,
  territory: string,
  desiredMinor: number,
): Promise<string> => {
  let next: string | null =
    `/v1/subscriptions/${subId}/pricePoints?filter[territory]=${territory}&limit=200`;
  while (next) {
    const res = (await apiFetch(next.replace(API_BASE, ""))) as {
      data: Array<{
        id: string;
        attributes: { customerPrice: string };
      }>;
      links?: { next?: string };
    };
    for (const pp of res.data) {
      const minor = Math.round(Number(pp.attributes.customerPrice) * 100);
      if (minor === desiredMinor) return pp.id;
    }
    next = res.links?.next ?? null;
  }
  throw new Error(
    `No Apple subscriptionPricePoint matches ${desiredMinor} minor units in territory ${territory} for subscription ${subId}`,
  );
};
