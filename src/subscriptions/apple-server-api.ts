import {
  AppStoreServerAPIClient,
  Environment,
  type StatusResponse,
  type TransactionInfoResponse,
} from "@apple/app-store-server-library";
import { IS_PRODUCTION } from "@/config";
import { AppError } from "@/utils/errors";

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

export const resetAppleApiClientForTests = () => {
  cachedClient = null;
};

export const setAppleApiClientForTests = (client: AppStoreServerAPIClient) => {
  cachedClient = client;
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

/**
 * Fetch a single signed transaction by id. Returned `signedTransactionInfo`
 * is a JWS that must be verified before being trusted.
 */
export const getTransactionInfo = async (
  transactionId: string,
): Promise<TransactionInfoResponse> =>
  getAppleApiClient().getTransactionInfo(transactionId);
