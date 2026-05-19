import { generateKeyPairSync } from "node:crypto";
import { Environment } from "@apple/app-store-server-library";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  buildAppleApiConfig,
  getAppleApiClient,
  resetAppleApiClientForTests,
} from "@/subscriptions/apple-server-api";

const ENV_KEYS = [
  "APPLE_ENV",
  "APPLE_BUNDLE_ID",
  "APPLE_API_ISSUER_ID",
  "APPLE_API_KEY_ID",
  "APPLE_API_SIGNING_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

const snapshot = (): Record<EnvKey, string | undefined> => {
  const out = {} as Record<EnvKey, string | undefined>;
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out;
};

const setOrDelete = (
  key: EnvKey,
  value: string | undefined,
  applyDelete: () => void,
) => {
  if (value === undefined) {
    applyDelete();
  } else {
    process.env[key] = value;
  }
};

const restore = (snap: Record<EnvKey, string | undefined>) => {
  setOrDelete("APPLE_ENV", snap.APPLE_ENV, () => {
    delete process.env.APPLE_ENV;
  });
  setOrDelete("APPLE_BUNDLE_ID", snap.APPLE_BUNDLE_ID, () => {
    delete process.env.APPLE_BUNDLE_ID;
  });
  setOrDelete("APPLE_API_ISSUER_ID", snap.APPLE_API_ISSUER_ID, () => {
    delete process.env.APPLE_API_ISSUER_ID;
  });
  setOrDelete("APPLE_API_KEY_ID", snap.APPLE_API_KEY_ID, () => {
    delete process.env.APPLE_API_KEY_ID;
  });
  setOrDelete("APPLE_API_SIGNING_KEY", snap.APPLE_API_SIGNING_KEY, () => {
    delete process.env.APPLE_API_SIGNING_KEY;
  });
};

let testSigningKeyPem: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  testSigningKeyPem = privateKey as unknown as string;
});

const setValidEnv = () => {
  process.env.APPLE_ENV = "sandbox";
  process.env.APPLE_BUNDLE_ID = "app.convos.test";
  process.env.APPLE_API_ISSUER_ID = "11111111-2222-3333-4444-555555555555";
  process.env.APPLE_API_KEY_ID = "ABCDE12345";
  process.env.APPLE_API_SIGNING_KEY = testSigningKeyPem;
};

describe("buildAppleApiConfig", () => {
  let snap: Record<EnvKey, string | undefined>;

  beforeEach(() => {
    snap = snapshot();
    setValidEnv();
    resetAppleApiClientForTests();
  });

  afterEach(() => {
    restore(snap);
    resetAppleApiClientForTests();
  });

  test("loads required env into a typed config", () => {
    const cfg = buildAppleApiConfig();
    expect(cfg.issuerId).toBe("11111111-2222-3333-4444-555555555555");
    expect(cfg.keyId).toBe("ABCDE12345");
    expect(cfg.signingKey).toBe(testSigningKeyPem.trim());
    expect(cfg.bundleId).toBe("app.convos.test");
    expect(cfg.environment).toBe(Environment.SANDBOX);
  });

  test("APPLE_ENV=production -> Environment.PRODUCTION", () => {
    process.env.APPLE_ENV = "production";
    const cfg = buildAppleApiConfig();
    expect(cfg.environment).toBe(Environment.PRODUCTION);
  });

  test("APPLE_ENV=local-testing -> Environment.LOCAL_TESTING", () => {
    process.env.APPLE_ENV = "local-testing";
    const cfg = buildAppleApiConfig();
    expect(cfg.environment).toBe(Environment.LOCAL_TESTING);
  });

  test("missing APPLE_API_ISSUER_ID throws", () => {
    delete process.env.APPLE_API_ISSUER_ID;
    expect(() => buildAppleApiConfig()).toThrow(/APPLE_API_ISSUER_ID/);
  });

  test("missing APPLE_API_KEY_ID throws", () => {
    delete process.env.APPLE_API_KEY_ID;
    expect(() => buildAppleApiConfig()).toThrow(/APPLE_API_KEY_ID/);
  });

  test("missing APPLE_API_SIGNING_KEY throws", () => {
    delete process.env.APPLE_API_SIGNING_KEY;
    expect(() => buildAppleApiConfig()).toThrow(/APPLE_API_SIGNING_KEY/);
  });

  test("missing APPLE_BUNDLE_ID throws", () => {
    delete process.env.APPLE_BUNDLE_ID;
    expect(() => buildAppleApiConfig()).toThrow(/APPLE_BUNDLE_ID/);
  });

  test("whitespace-only signing key counts as missing", () => {
    process.env.APPLE_API_SIGNING_KEY = "   ";
    expect(() => buildAppleApiConfig()).toThrow(/APPLE_API_SIGNING_KEY/);
  });
});

describe("getAppleApiClient", () => {
  let snap: Record<EnvKey, string | undefined>;

  beforeEach(() => {
    snap = snapshot();
    setValidEnv();
    resetAppleApiClientForTests();
  });

  afterEach(() => {
    restore(snap);
    resetAppleApiClientForTests();
  });

  test("caches the client across calls", () => {
    const a = getAppleApiClient();
    const b = getAppleApiClient();
    expect(a).toBe(b);
  });

  test("resetAppleApiClientForTests forces a rebuild", () => {
    const a = getAppleApiClient();
    resetAppleApiClientForTests();
    const b = getAppleApiClient();
    expect(a).not.toBe(b);
  });
});
