import { google, type androidpublisher_v3 } from "googleapis";
import { AppError } from "@/utils/errors";

export type SubscriptionPurchaseV2 =
  androidpublisher_v3.Schema$SubscriptionPurchaseV2;

const requireEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new AppError(
      500,
      `${key} is not configured for Google Play Developer API access`,
    );
  }
  return value;
};

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

let cachedClient: androidpublisher_v3.Androidpublisher | null = null;
let cachedPackageName: string | null = null;

const buildClient = (): {
  client: androidpublisher_v3.Androidpublisher;
  packageName: string;
} => {
  if (cachedClient && cachedPackageName) {
    return { client: cachedClient, packageName: cachedPackageName };
  }
  const packageName = requireEnv("GOOGLE_PLAY_PACKAGE_NAME");
  const keyJson = requireEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(keyJson) as Record<string, unknown>;
  } catch (err) {
    throw new AppError(
      500,
      `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [SCOPE],
  });
  cachedClient = google.androidpublisher({ version: "v3", auth });
  cachedPackageName = packageName;
  return { client: cachedClient, packageName };
};

export const resetPlayApiClientForTests = () => {
  cachedClient = null;
  cachedPackageName = null;
};

export type PlayApiFixtureGetter = (
  purchaseToken: string,
) => SubscriptionPurchaseV2 | null;

let fixtureGetter: PlayApiFixtureGetter | null = null;

/**
 * Test escape hatch. When set (and `LOCAL_TESTING=1`),
 * `fetchSubscriptionPurchaseV2` returns whatever the registered getter yields
 * for the given purchaseToken, bypassing the real Google API.
 */
export const setPlayApiFixtureForTests = (
  getter: PlayApiFixtureGetter | null,
) => {
  fixtureGetter = getter;
};

const isLocalTesting = () => process.env.LOCAL_TESTING === "1";

export const fetchSubscriptionPurchaseV2 = async (
  purchaseToken: string,
): Promise<SubscriptionPurchaseV2> => {
  if (isLocalTesting() && fixtureGetter) {
    const fx = fixtureGetter(purchaseToken);
    if (!fx) {
      throw new AppError(
        404,
        `No Play API fixture registered for purchaseToken ${purchaseToken}`,
      );
    }
    return fx;
  }
  const { client, packageName } = buildClient();
  const res = await client.purchases.subscriptionsv2.get({
    packageName,
    token: purchaseToken,
  });
  return res.data;
};

/**
 * Acknowledge a pending purchase. Google voids unacknowledged subscription
 * purchases after 3 days, so we call this after a successful verify whenever
 * the fetched purchase reports `ACKNOWLEDGEMENT_STATE_PENDING`. Safe to
 * fire-and-forget — Google ignores acknowledgements on already-acked tokens.
 */
export const acknowledgePurchase = async (
  productId: string,
  purchaseToken: string,
): Promise<void> => {
  if (isLocalTesting() && fixtureGetter) {
    return;
  }
  const { client, packageName } = buildClient();
  await client.purchases.subscriptions.acknowledge({
    packageName,
    subscriptionId: productId,
    token: purchaseToken,
  });
};
