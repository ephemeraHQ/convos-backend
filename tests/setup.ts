import { beforeAll, beforeEach } from "vitest";

// vi.mock for firebase-admin lives in __mocks__/ + per-test-file vi.mock()
// declarations.

// Local dev: load DATABASE_URL (and any other vars) from .env when the shell
// hasn't already provided it. CI sets DATABASE_URL as a real env var, so this
// no-ops there. vitest does not read .env on its own, unlike the prisma CLI.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file present (e.g. CI) — rely on the ambient environment.
  }
}

// Pin pino to JSON output during tests; pino-pretty starts a worker thread
// that can race the Vitest test-file teardown when many files run.
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
process.env.PAYMENTS_SIGNUP_BONUS_CREDITS = "5000";
process.env.PAYMENTS_CRON_API_KEY =
  process.env.PAYMENTS_CRON_API_KEY ||
  "test-cron-api-key-that-is-at-least-32-characters-long";

// Subscription credit allotment — placeholder value for tests. Final
// number is set by ops via env in each deploy environment.
process.env.PAYMENTS_GRANT_PLUS_MONTHLY =
  process.env.PAYMENTS_GRANT_PLUS_MONTHLY || "2500";

// PII redaction defaults to a no-op pass-through in tests, so the many handler
// tests that create/patch templates don't make a real (fail-closed) OpenRouter
// call. Tests that exercise redaction itself opt out via
// __resetPiiRedactionForTests(null). Dynamic import so config.ts (required env
// above) is loaded only after this file's env assignments have run.
async function installPiiRedactionNoop() {
  const { __resetPiiRedactionForTests } =
    await import("@/api/v2/agent-templates/services/moderation");
  __resetPiiRedactionForTests((fields) =>
    Promise.resolve({ fields, findings: [] }),
  );
}
// beforeAll covers fixtures seeded in a file's own beforeAll/beforeEach;
// beforeEach re-asserts in case a test mutated the override.
beforeAll(installPiiRedactionNoop);
beforeEach(installPiiRedactionNoop);
