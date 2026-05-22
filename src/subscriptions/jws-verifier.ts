import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Environment,
  SignedDataVerifier,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import { AppError } from "@/utils/errors";

// Read NODE_ENV dynamically (not from the cached `isProductionEnv()` config
// constant) so the prod-only guard below stays testable. NODE_ENV doesn't
// change mid-process in production, so the runtime behavior is identical.
const isProductionEnv = () => process.env.NODE_ENV === "production";

export type AppleEnvironment = Environment;
export { Environment };

const CERT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "certs",
);

const loadAppleRootCerts = () => [
  readFileSync(path.join(CERT_DIR, "AppleRootCA-G2.cer")),
  readFileSync(path.join(CERT_DIR, "AppleRootCA-G3.cer")),
];

const resolveEnvironment = () => {
  const raw = process.env.APPLE_ENV?.trim();
  const isProd = isProductionEnv();
  if (raw === "production") return Environment.PRODUCTION;
  if (raw === "sandbox") {
    // Sandbox is a legitimate combination with NODE_ENV=production for any
    // non-laptop deploy pointed at Apple's sandbox endpoint (e.g. otr-dev,
    // staging, TestFlight backend). The previous defense-in-depth check
    // rejected this combination, breaking the dev deploy. Real prod
    // misconfigured with APPLE_ENV=sandbox still fails closed at signature
    // time — Apple-Production-signed notifications fail INVALID_ENVIRONMENT
    // against a Sandbox-configured verifier — so the operator-error blast
    // radius is "no notifications work", not "forged ones accepted".
    return Environment.SANDBOX;
  }
  if (raw === "local-testing") {
    // LOCAL_TESTING bypasses JWS signature + chain verification entirely
    // (the library treats payloads as pre-verified). A misconfigured prod
    // env with APPLE_ENV=local-testing would silently accept any forged
    // transaction as real. Fail loudly instead — this is the one APPLE_ENV
    // value that is unsafe under NODE_ENV=production.
    if (isProd) {
      throw new AppError(
        500,
        "APPLE_ENV=local-testing is forbidden in production",
      );
    }
    return Environment.LOCAL_TESTING;
  }
  return isProd ? Environment.PRODUCTION : Environment.SANDBOX;
};

const resolveBundleId = () => {
  const bundleId = process.env.APPLE_BUNDLE_ID?.trim();
  if (!bundleId) {
    throw new AppError(
      500,
      "APPLE_BUNDLE_ID is not configured for subscription verification",
    );
  }
  return bundleId;
};

const resolveAppAppleId = () => {
  const raw = process.env.APPLE_APP_APPLE_ID?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new AppError(
      500,
      `APPLE_APP_APPLE_ID is not a positive integer: "${raw}"`,
    );
  }
  return n;
};

export type VerifierConfig = {
  rootCertificates: Buffer[];
  enableOnlineChecks: boolean;
  environment: Environment;
  bundleId: string;
  appAppleId?: number;
};

export const buildVerifierConfig = (): VerifierConfig => {
  const environment = resolveEnvironment();
  return {
    rootCertificates: loadAppleRootCerts(),
    enableOnlineChecks: environment === Environment.PRODUCTION,
    environment,
    bundleId: resolveBundleId(),
    appAppleId:
      environment === Environment.SANDBOX ? undefined : resolveAppAppleId(),
  };
};

let cachedVerifier: SignedDataVerifier | null = null;

export const getVerifier = () => {
  if (cachedVerifier) return cachedVerifier;
  const cfg = buildVerifierConfig();
  cachedVerifier = new SignedDataVerifier(
    cfg.rootCertificates,
    cfg.enableOnlineChecks,
    cfg.environment,
    cfg.bundleId,
    cfg.appAppleId,
  );
  return cachedVerifier;
};

export const resetVerifierForTests = () => {
  cachedVerifier = null;
};

export const setVerifierForTests = (verifier: SignedDataVerifier) => {
  cachedVerifier = verifier;
};

export const verifyAndDecodeNotification = async (
  signedPayload: string,
): Promise<ResponseBodyV2DecodedPayload> =>
  getVerifier().verifyAndDecodeNotification(signedPayload);

export const verifyAndDecodeTransaction = async (
  signedTransactionInfo: string,
): Promise<JWSTransactionDecodedPayload> =>
  getVerifier().verifyAndDecodeTransaction(signedTransactionInfo);
