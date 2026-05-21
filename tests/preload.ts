import { mock } from "vitest";

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

// Assistant runtime defaults — tests can override per-case via
// __setAssistantConfigOverridesForTests in assistant-config.ts.
process.env.ASSISTANT_API_URL =
  process.env.ASSISTANT_API_URL || "https://assistants.test.local";
process.env.ASSISTANT_API_KEY =
  process.env.ASSISTANT_API_KEY || "test-assistant-key";
// Shrink the server-side join wait so tests don't burn 25s each.
process.env.ASSISTANT_JOIN_WAIT_BUDGET_MS =
  process.env.ASSISTANT_JOIN_WAIT_BUDGET_MS || "200";
process.env.ASSISTANT_JOIN_POLL_INTERVAL_MS =
  process.env.ASSISTANT_JOIN_POLL_INTERVAL_MS || "20";

// Public template URL origin (required by config.ts; no prod default).
process.env.BUILDER_SITE_URL =
  process.env.BUILDER_SITE_URL || "https://dev.convos.org";

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
process.env.PAYMENTS_MARKUP_RATE = "2.0";
process.env.PAYMENTS_CREDITS_PER_USD = "1000";
process.env.PAYMENTS_RESERVED_MAX_TURN_CREDITS = "1";
process.env.PAYMENTS_MIN_BALANCE_CREDITS = "-1000";
process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = "100";
process.env.PAYMENTS_CRON_API_KEY =
  process.env.PAYMENTS_CRON_API_KEY ||
  "test-cron-api-key-that-is-at-least-32-characters-long";

// Subscription tier credit allotments — placeholder values for tests.
// Final numbers are set by ops via env in each deploy environment.
process.env.PAYMENTS_GRANT_BUILDER_MONTHLY =
  process.env.PAYMENTS_GRANT_BUILDER_MONTHLY || "2500";
process.env.PAYMENTS_GRANT_PRO_MONTHLY =
  process.env.PAYMENTS_GRANT_PRO_MONTHLY || "10000";

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
      if (message.token === "trigger-payload-size-limit") {
        const error = new Error("Payload too large") as Error & {
          code: string;
        };
        error.code = "messaging/payload-size-limit-exceeded";
        return Promise.reject(error);
      }
      const error = new Error("Invalid registration token");
      (error as Error & { code: string }).code =
        "messaging/invalid-registration-token";
      return Promise.reject(error);
    },
  }),
}));
