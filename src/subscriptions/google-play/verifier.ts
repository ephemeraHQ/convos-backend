import { OAuth2Client } from "google-auth-library";
import { AppError } from "@/utils/errors";

const requireEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new AppError(500, `${key} is not configured for Pub/Sub RTDN auth`);
  }
  return value;
};

export class PubsubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PubsubAuthError";
    Object.setPrototypeOf(this, PubsubAuthError.prototype);
  }
}

// Read NODE_ENV dynamically so the prod guard stays testable. NODE_ENV doesn't
// change mid-process in production, so runtime behavior is identical.
const isProductionEnv = () => process.env.NODE_ENV === "production";

let cachedClient: OAuth2Client | null = null;
const getOAuthClient = () => {
  if (cachedClient) return cachedClient;
  cachedClient = new OAuth2Client();
  return cachedClient;
};

/**
 * Test escape hatch. When set (and `LOCAL_TESTING=1`),
 * `verifyPubsubPushAuth` short-circuits to this resolver: a thrown error
 * fails the verification, a clean return passes. Lets tests assert webhook
 * dispatch without minting real OIDC tokens.
 */
let testVerifier:
  | ((authorizationHeader: string | undefined) => void | Promise<void>)
  | null = null;

export const setPubsubVerifierForTests = (
  verifier:
    | ((authorizationHeader: string | undefined) => void | Promise<void>)
    | null,
) => {
  // Installing a verifier that bypasses OIDC validation must never be possible
  // in production, even if LOCAL_TESTING is misconfigured on a deployed env.
  if (isProductionEnv()) {
    throw new Error(
      "setPubsubVerifierForTests is forbidden in production (NODE_ENV=production)",
    );
  }
  testVerifier = verifier;
};

const ACCEPTED_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);

/**
 * Verifies a Google Cloud Pub/Sub push request's OIDC bearer token. The token
 * is signed by the Pub/Sub-push service account configured on the topic
 * subscription; we verify the signature, that the audience matches our
 * webhook URL, and that the issuer + email match what we expect.
 *
 * Throws PubsubAuthError on any failure. Returns on success.
 */
export const verifyPubsubPushAuth = async (
  authorizationHeader: string | undefined,
): Promise<void> => {
  // Defense in depth: even if a testVerifier somehow survived into a prod
  // process, never let it short-circuit Google-signed OIDC verification.
  if (!isProductionEnv() && process.env.LOCAL_TESTING === "1" && testVerifier) {
    await testVerifier(authorizationHeader);
    return;
  }

  if (!authorizationHeader) {
    throw new PubsubAuthError("Missing Authorization header");
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) {
    throw new PubsubAuthError("Authorization header is not a Bearer token");
  }
  const idToken = match[1];

  const audience = requireEnv("GOOGLE_PLAY_RTDN_PUBSUB_AUDIENCE");
  const expectedEmail = requireEnv("GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL");

  let ticket;
  try {
    ticket = await getOAuthClient().verifyIdToken({ idToken, audience });
  } catch (err) {
    throw new PubsubAuthError(
      `OIDC verifyIdToken failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const payload = ticket.getPayload();
  if (!payload) {
    throw new PubsubAuthError("OIDC token has no payload");
  }
  if (!payload.iss || !ACCEPTED_ISSUERS.has(payload.iss)) {
    throw new PubsubAuthError(`Unexpected issuer: ${payload.iss}`);
  }
  if (payload.email !== expectedEmail) {
    throw new PubsubAuthError(
      `Unexpected token email (expected ${expectedEmail})`,
    );
  }
  if (payload.email_verified !== true) {
    throw new PubsubAuthError("Token email is not verified");
  }
};
