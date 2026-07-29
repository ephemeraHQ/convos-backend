#!/usr/bin/env tsx

/**
 * Read-only CLI: check App Store subscription status for one or more
 * originalTransactionIds, straight from Apple's App Store Server API
 * (GET /inApps/v1/subscriptions/{originalTransactionId}) — the manual
 * version of what a reconcile job would do.
 *
 * Usage:
 *   pnpm apple:sub-status <originalTransactionId...> [--sandbox]
 *
 * Env (same vars the server uses — see src/subscriptions/apple-server-api.ts;
 * in the local .env they live in the "# IAP Prod" block):
 *   APPLE_API_KEY_ID, APPLE_API_ISSUER_ID, APPLE_BUNDLE_ID,
 *   APPLE_API_SIGNING_KEY
 *
 * Defaults to the PRODUCTION host. Pass --sandbox to query
 * api.storekit-sandbox.itunes.apple.com instead — TestFlight purchases live
 * in the sandbox environment, so a 404/4040010 on production usually means
 * "retry with --sandbox".
 *
 * Deliberately self-contained (no imports from src/): importing
 * src/subscriptions/apple-server-api.ts drags in @/config, which throws at
 * load time on unrelated missing env vars, and pins the environment to
 * APPLE_ENV instead of a CLI flag. Same underlying library, same host logic.
 *
 * Strictly read-only against Apple. No database access. Never prints env
 * values.
 */
import {
  APIException,
  AppStoreServerAPIClient,
  Environment,
  type StatusResponse,
} from "@apple/app-store-server-library";

const USAGE = `Usage:
  pnpm apple:sub-status <originalTransactionId...> [--sandbox]
  pnpm tsx --env-file-if-exists=.env scripts/check-apple-subscription-status.ts <originalTransactionId...> [--sandbox]

Checks App Store subscription status straight from Apple (read-only):
GET /inApps/v1/subscriptions/{originalTransactionId}

Options:
  --sandbox   Query api.storekit-sandbox.itunes.apple.com instead of the
              production host (TestFlight purchases live in the sandbox
              environment).
  -h, --help  Show this help.

Required env (in .env, "# IAP Prod" block — must be uncommented):
  APPLE_API_KEY_ID, APPLE_API_ISSUER_ID, APPLE_BUNDLE_ID, APPLE_API_SIGNING_KEY

Status codes: 1 active, 2 expired, 3 billing-retry, 4 grace-period, 5 revoked.`;

const REQUIRED_ENV_KEYS = [
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER_ID",
  "APPLE_BUNDLE_ID",
  "APPLE_API_SIGNING_KEY",
] as const;

const STATUS_LABELS = new Map<number, string>([
  [1, "active"],
  [2, "expired"],
  [3, "billing-retry"],
  [4, "grace-period"],
  [5, "revoked"],
]);

const EXPIRATION_INTENT_LABELS = new Map<number, string>([
  [1, "customer-canceled"],
  [2, "billing-error"],
  [3, "declined-price-increase"],
  [4, "product-unavailable"],
  [5, "other"],
]);

/** Fields we read from the decoded JWSTransaction payload. */
type TransactionPayload = {
  productId?: string;
  expiresDate?: number;
  environment?: string;
};

/** Fields we read from the decoded JWSRenewalInfo payload. */
type RenewalPayload = {
  autoRenewStatus?: number;
  expirationIntent?: number;
  environment?: string;
};

/**
 * Decode the middle (payload) segment of a JWS: base64url-encoded JSON.
 *
 * We deliberately skip signature verification — this is a read-only
 * diagnostic tool talking directly to Apple over TLS, not a trust boundary.
 * The server-side flow (src/subscriptions/jws-verifier.ts) does full x5c
 * chain verification before trusting these payloads.
 */
const decodeJwsPayload = (jws: string): Record<string, unknown> => {
  const segments = jws.split(".");
  if (segments.length !== 3) {
    throw new Error(
      `Malformed JWS: expected 3 segments, got ${segments.length}`,
    );
  }
  return JSON.parse(
    Buffer.from(segments[1], "base64url").toString("utf8"),
  ) as Record<string, unknown>;
};

const readAppleEnv = () => {
  const missing = REQUIRED_ENV_KEYS.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    console.error(
      'Fix: uncomment the "# IAP Prod" block in .env, then run via ' +
        "`pnpm apple:sub-status ...` (which loads .env). " +
        "This tool never prints env values.",
    );
    process.exit(1);
  }
  const env = (key: string) => (process.env[key] ?? "").trim();
  return {
    keyId: env("APPLE_API_KEY_ID"),
    issuerId: env("APPLE_API_ISSUER_ID"),
    bundleId: env("APPLE_BUNDLE_ID"),
    // .env stores the PEM double-quoted with "\n" escapes; node --env-file
    // expands those to real newlines, but normalize anyway in case the var
    // was exported by hand with literal backslash-n sequences.
    signingKey: env("APPLE_API_SIGNING_KEY").replace(/\\n/g, "\n"),
  };
};

const formatEpochMs = (ms: number | undefined) =>
  ms === undefined ? "?" : new Date(ms).toISOString();

const formatAutoRenewStatus = (value: number | undefined) =>
  value === undefined
    ? "?"
    : `${value} (${value === 1 ? "on" : value === 0 ? "off" : "unknown"})`;

const formatExpirationIntent = (value: number | undefined) =>
  value === undefined
    ? "(none)"
    : `${value} (${EXPIRATION_INTENT_LABELS.get(value) ?? "unknown"})`;

const printStatusResponse = (otx: string, response: StatusResponse) => {
  console.log(`\n== ${otx} ==`);
  console.log(
    `  response environment: ${response.environment ?? "?"}  bundleId: ${response.bundleId ?? "?"}`,
  );
  const groups = response.data ?? [];
  if (groups.length === 0) {
    console.log("  (no subscription groups returned)");
    return;
  }
  for (const group of groups) {
    console.log(
      `  subscription group ${group.subscriptionGroupIdentifier ?? "?"}:`,
    );
    for (const item of group.lastTransactions ?? []) {
      const status = item.status;
      const statusLabel =
        status === undefined
          ? "unknown"
          : (STATUS_LABELS.get(status) ?? "unknown");
      const txn = item.signedTransactionInfo
        ? (decodeJwsPayload(item.signedTransactionInfo) as TransactionPayload)
        : undefined;
      const renewal = item.signedRenewalInfo
        ? (decodeJwsPayload(item.signedRenewalInfo) as RenewalPayload)
        : undefined;
      console.log(
        `    - originalTransactionId: ${item.originalTransactionId ?? "?"}`,
      );
      console.log(`      status: ${status ?? "?"} (${statusLabel})`);
      console.log(`      productId: ${txn?.productId ?? "?"}`);
      console.log(`      expiresDate: ${formatEpochMs(txn?.expiresDate)}`);
      console.log(
        `      autoRenewStatus: ${formatAutoRenewStatus(renewal?.autoRenewStatus)}`,
      );
      console.log(
        `      expirationIntent: ${formatExpirationIntent(renewal?.expirationIntent)}`,
      );
      console.log(
        `      environment: ${txn?.environment ?? renewal?.environment ?? "?"}`,
      );
    }
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const flags = args.filter((arg) => arg.startsWith("-"));
  const unknownFlags = flags.filter((arg) => arg !== "--sandbox");
  if (unknownFlags.length > 0) {
    console.error(`Unknown option(s): ${unknownFlags.join(", ")}\n`);
    console.error(USAGE);
    process.exit(1);
  }
  const otxIds = args.filter((arg) => !arg.startsWith("-"));
  if (otxIds.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }

  const sandbox = flags.includes("--sandbox");
  const cfg = readAppleEnv();
  const client = new AppStoreServerAPIClient(
    cfg.signingKey,
    cfg.keyId,
    cfg.issuerId,
    cfg.bundleId,
    sandbox ? Environment.SANDBOX : Environment.PRODUCTION,
  );
  console.log(
    `Querying ${sandbox ? "SANDBOX (api.storekit-sandbox.itunes.apple.com)" : "PRODUCTION (api.storekit.itunes.apple.com)"} as bundle ${cfg.bundleId}`,
  );

  let failures = 0;
  for (const otx of otxIds) {
    try {
      const response = await client.getAllSubscriptionStatuses(otx);
      printStatusResponse(otx, response);
    } catch (error) {
      failures += 1;
      console.error(`\n== ${otx} ==`);
      if (error instanceof APIException) {
        console.error(
          `  HTTP ${error.httpStatusCode} — apiError=${String(error.apiError ?? "none")}` +
            ` (4040010 = originalTransactionId not found on this host; ` +
            `TestFlight/sandbox purchases need --sandbox)`,
        );
      } else {
        console.error(
          `  ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (failures > 0) {
    process.exit(1);
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
