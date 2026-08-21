import {
  APIError,
  APIException,
  AppStoreServerAPIClient,
  Environment,
  type StatusResponse,
  type TransactionInfoResponse,
} from "@apple/app-store-server-library";
import { IS_PRODUCTION } from "@/config";
import { AppError } from "@/utils/errors";
import logger from "@/utils/logger";

const resolveEnvironment = () => {
  const raw = process.env.APPLE_ENV?.trim();
  if (raw === "production") return Environment.PRODUCTION;
  if (raw === "sandbox") return Environment.SANDBOX;
  if (raw === "local-testing") return Environment.LOCAL_TESTING;
  return IS_PRODUCTION ? Environment.PRODUCTION : Environment.SANDBOX;
};

const requireEnv = (key: string) => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new AppError(
      500,
      `${key} is not configured for App Store Server API access`,
    );
  }
  return value;
};

export type AppleApiConfig = {
  issuerId: string;
  keyId: string;
  signingKey: string;
  bundleId: string;
  environment: Environment;
};

export const buildAppleApiConfig = (): AppleApiConfig => ({
  issuerId: requireEnv("APPLE_API_ISSUER_ID"),
  keyId: requireEnv("APPLE_API_KEY_ID"),
  signingKey: requireEnv("APPLE_API_SIGNING_KEY"),
  bundleId: requireEnv("APPLE_BUNDLE_ID"),
  environment: resolveEnvironment(),
});

let cachedClient: AppStoreServerAPIClient | null = null;
const cachedClientsByEnvironment = new Map<
  Environment,
  AppStoreServerAPIClient
>();

export const getAppleApiClient = () => {
  if (cachedClient) return cachedClient;
  const cfg = buildAppleApiConfig();
  cachedClient = new AppStoreServerAPIClient(
    cfg.signingKey,
    cfg.keyId,
    cfg.issuerId,
    cfg.bundleId,
    cfg.environment,
  );
  return cachedClient;
};

/**
 * A client pinned to an EXPLICIT App Store Server API environment, regardless
 * of `APPLE_ENV`. Sandbox (TestFlight) transactions only resolve on the
 * sandbox host, so callers that must read both worlds (the reconcile job)
 * need a client per environment.
 */
export const getAppleApiClientForEnvironment = (environment: Environment) => {
  const existing = cachedClientsByEnvironment.get(environment);
  if (existing) return existing;
  const cfg = buildAppleApiConfig();
  const client = new AppStoreServerAPIClient(
    cfg.signingKey,
    cfg.keyId,
    cfg.issuerId,
    cfg.bundleId,
    environment,
  );
  cachedClientsByEnvironment.set(environment, client);
  return client;
};

export const resetAppleApiClientForTests = () => {
  cachedClient = null;
  cachedClientsByEnvironment.clear();
};

export const setAppleApiClientForTests = (client: AppStoreServerAPIClient) => {
  cachedClient = client;
};

export const setAppleApiClientForEnvironmentForTests = (
  environment: Environment,
  client: AppStoreServerAPIClient,
) => {
  cachedClientsByEnvironment.set(environment, client);
};

/**
 * Fetch every auto-renewable subscription status for the customer associated
 * with `anyTransactionId`. Returned `lastTransactions` JWS payloads still need
 * to be verified via the JWS verifier before being trusted.
 */
export const getSubscriptionStatuses = async (
  anyTransactionId: string,
): Promise<StatusResponse> =>
  getAppleApiClient().getAllSubscriptionStatuses(anyTransactionId);

export type SubscriptionStatusesResult = {
  response: StatusResponse;
  /** The environment (host) that actually answered. */
  environment: Environment;
};

// A transaction id that lives in the OTHER environment resolves as 404
// not-found on this host (TRANSACTION_ID_NOT_FOUND = 4040010; some responses
// use ORIGINAL_TRANSACTION_ID_NOT_FOUND = 4040005). Unlike the JWS verifier —
// which sees INVALID_ENVIRONMENT after the signature checks — the Server API
// gives no dedicated wrong-environment signal, so not-found is the fallback
// trigger. Mirrors the JWS verifier's production→sandbox fallback map.
const API_FALLBACK_ENVIRONMENT: Partial<Record<Environment, Environment>> = {
  [Environment.PRODUCTION]: Environment.SANDBOX,
  [Environment.SANDBOX]: Environment.PRODUCTION,
};

const isTransactionNotFound = (err: unknown): boolean =>
  err instanceof APIException &&
  (err.apiError === APIError.TRANSACTION_ID_NOT_FOUND ||
    err.apiError === APIError.ORIGINAL_TRANSACTION_ID_NOT_FOUND);

/**
 * `getAllSubscriptionStatuses` with an environment fallback, for callers that
 * hold transaction ids from both worlds (production purchases AND
 * TestFlight/sandbox ones): query the configured environment first and, only
 * on a not-found (4040010 / 4040005), retry the opposite host. Passing
 * `opts.environment` pins the query to that environment (no fallback).
 *
 * Returned JWS payloads still need to be verified via the JWS verifier before
 * being trusted (the verifier has its own, symmetric environment fallback).
 */
export const getSubscriptionStatusesWithEnvironmentFallback = async (
  anyTransactionId: string,
  opts?: { environment?: Environment },
): Promise<SubscriptionStatusesResult> => {
  if (opts?.environment) {
    const response = await getAppleApiClientForEnvironment(
      opts.environment,
    ).getAllSubscriptionStatuses(anyTransactionId);
    return { response, environment: opts.environment };
  }

  const primary = resolveEnvironment();
  try {
    const response =
      await getAppleApiClientForEnvironment(primary).getAllSubscriptionStatuses(
        anyTransactionId,
      );
    return { response, environment: primary };
  } catch (err) {
    const alternate = API_FALLBACK_ENVIRONMENT[primary];
    if (!alternate || !isTransactionNotFound(err)) throw err;
    logger.info(
      { primary, alternate },
      "apple.server_api.environment_fallback — transaction not found in the primary environment; retrying against the alternate host",
    );
    const response =
      await getAppleApiClientForEnvironment(
        alternate,
      ).getAllSubscriptionStatuses(anyTransactionId);
    return { response, environment: alternate };
  }
};

/**
 * Fetch a single signed transaction by id. Returned `signedTransactionInfo`
 * is a JWS that must be verified before being trusted.
 */
export const getTransactionInfo = async (
  transactionId: string,
): Promise<TransactionInfoResponse> =>
  getAppleApiClient().getTransactionInfo(transactionId);
