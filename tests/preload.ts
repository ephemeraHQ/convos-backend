import { mock } from "bun:test";

// Disable pino-pretty worker threads to prevent Bun segfaults during tests
process.env.LOG_FORMAT = "json";

// Set required environment variables for tests
process.env.PUBLIC_ASSETS_BUCKET = "test-public-assets-bucket";
process.env.FIREBASE_SERVICE_ACCOUNT = "{}";
process.env.XMTP_ENV = "local";
process.env.NOTIFICATION_SERVER_URL = "http://localhost:8080";
// Only set default if not already set (CI uses GitHub secrets)
process.env.XMTP_NOTIFICATION_SECRET =
  process.env.XMTP_NOTIFICATION_SECRET || "test-notification-secret";

process.env.SIWE_DOMAIN = process.env.SIWE_DOMAIN || "convos.app";
process.env.SIWE_URI = process.env.SIWE_URI || "https://convos.app";
process.env.SIWE_ALLOWED_CHAIN_IDS = process.env.SIWE_ALLOWED_CHAIN_IDS || "1";
// 64-char hex = 32 bytes. Test secret only.
process.env.NONCE_HMAC_SECRET =
  process.env.NONCE_HMAC_SECRET ||
  "0000000000000000000000000000000000000000000000000000000000000000";

// v2 JWT test keys (ECDSA P-256) - must be set before config.ts loads
process.env.JWT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGis9E4WiE4Ou51Ho
2tH6goYKt2nxLsKgadVvCYaklRyhRANCAARIw/oKiY4bkkW8iOcgiyUb1XPOtBQ4
/7NXGEExhSwpySP8P8tpOUlKoI2DryaYFx4EJhqtnV3Dhp1wLcxDKZYG
-----END PRIVATE KEY-----`;

process.env.JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAESMP6ComOG5JFvIjnIIslG9VzzrQU
OP+zVxhBMYUsKckj/D/LaTlJSqCNg68mmBceBCYarZ1dw4adcC3MQymWBg==
-----END PUBLIC KEY-----`;

// Payments / credits test defaults.
//
// PAYMENTS_MARKUP_RATE
//   Dimensionless multiplier applied to upstream USD cost when computing
//   the credit charge. `2.0` means "charge the user 2× the raw model
//   cost". Float, parsed and quantized to basis points at config load.
//   Must be >= 0.
//
// PAYMENTS_CREDITS_PER_USD
//   Pricing constant: how many credits represent one US dollar. `1000`
//   means 1 credit = $0.001 (a tenth of a cent). Integer, must be > 0.
//   Used by usdToCredits / creditsToUsd and snapshotted on each consume
//   ledger row so historical USD value is reconstructable.
//
// PAYMENTS_RESERVED_MAX_TURN_CREDITS
//   Pre-call reservation budget in credits. `isAllowed` returns true
//   when balance > this value, so the caller can afford one expected
//   worst-case turn. `1` is permissive (any positive balance allows a
//   turn). Operator tunes upward for stricter gating. Integer, >= 0.
//
// PAYMENTS_MIN_BALANCE_CREDITS
//   Hard negative floor in credits. `consume` and negative `adjust`
//   throw InsufficientBalanceError if applying the delta would drive
//   balance below this. `-1000` (~ -$1 at default pricing) caps damage
//   from runaway agents while still permitting the documented
//   "1-turn over-spend" behavior. Integer, must be <= 0.
process.env.PAYMENTS_MARKUP_RATE = "2.0";
process.env.PAYMENTS_CREDITS_PER_USD = "1000";
process.env.PAYMENTS_RESERVED_MAX_TURN_CREDITS = "1";
process.env.PAYMENTS_MIN_BALANCE_CREDITS = "-1000";

// mock Firebase functions

void mock.module("firebase-admin/app-check", () => ({
  getAppCheck: () => ({
    verifyToken: (token: string) => {
      if (token === "valid-app-check-token") {
        return Promise.resolve(true);
      }
      return Promise.reject(new Error("Invalid AppCheck token"));
    },
    createToken: (_appId: string) => {
      return Promise.resolve({
        token: "valid-app-check-token",
      });
    },
  }),
}));

void mock.module("firebase-admin/app", () => ({
  initializeApp: () => {},
  cert: () => {},
}));

void mock.module("firebase-admin/messaging", () => ({
  getMessaging: () => ({
    send: (message: { token?: string }) => {
      if (message.token === "valid-fcm-token") {
        return Promise.resolve("mock-message-id");
      }
      const error = new Error("Invalid registration token");
      (error as Error & { code: string }).code =
        "messaging/invalid-registration-token";
      return Promise.reject(error);
    },
  }),
}));
