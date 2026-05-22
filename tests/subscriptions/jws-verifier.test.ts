import { generateKeyPairSync } from "node:crypto";
import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import { importPKCS8, SignJWT } from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  buildVerifierConfig,
  getVerifier,
  resetVerifierForTests,
  setVerifierForTests,
  verifyAndDecodeNotification,
  verifyAndDecodeTransaction,
} from "@/subscriptions/jws-verifier";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const TEST_BUNDLE_ID = "app.convos.test";

type EnvSnapshot = {
  APPLE_ENV: string | undefined;
  APPLE_BUNDLE_ID: string | undefined;
  APPLE_APP_APPLE_ID: string | undefined;
};

const envSnapshot = (): EnvSnapshot => ({
  APPLE_ENV: process.env.APPLE_ENV,
  APPLE_BUNDLE_ID: process.env.APPLE_BUNDLE_ID,
  APPLE_APP_APPLE_ID: process.env.APPLE_APP_APPLE_ID,
});

const restoreEnv = (snap: EnvSnapshot) => {
  if (snap.APPLE_ENV === undefined) {
    delete process.env.APPLE_ENV;
  } else {
    process.env.APPLE_ENV = snap.APPLE_ENV;
  }
  if (snap.APPLE_BUNDLE_ID === undefined) {
    delete process.env.APPLE_BUNDLE_ID;
  } else {
    process.env.APPLE_BUNDLE_ID = snap.APPLE_BUNDLE_ID;
  }
  if (snap.APPLE_APP_APPLE_ID === undefined) {
    delete process.env.APPLE_APP_APPLE_ID;
  } else {
    process.env.APPLE_APP_APPLE_ID = snap.APPLE_APP_APPLE_ID;
  }
};

let signingPrivateKey: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  signingPrivateKey = privateKey;
});

const signPayload = async (payload: object): Promise<string> => {
  const privateKey = await importPKCS8(signingPrivateKey, "ES256");
  return new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: "ES256" })
    .sign(privateKey);
};

const expectRejects = async (fn: () => Promise<unknown>) => {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
};

const installLocalTestingVerifier = () => {
  const verifier = new SignedDataVerifier(
    [],
    false,
    Environment.LOCAL_TESTING,
    TEST_BUNDLE_ID,
    1234,
  );
  setVerifierForTests(verifier);
};

describe("buildVerifierConfig", () => {
  let snap: ReturnType<typeof envSnapshot>;

  beforeEach(() => {
    snap = envSnapshot();
    process.env.APPLE_BUNDLE_ID = TEST_BUNDLE_ID;
    resetVerifierForTests();
  });

  afterEach(() => {
    restoreEnv(snap);
    resetVerifierForTests();
  });

  test("loads both Apple root certs as DER buffers", () => {
    const cfg = buildVerifierConfig();
    expect(cfg.rootCertificates).toHaveLength(2);
    for (const cert of cfg.rootCertificates) {
      expect(Buffer.isBuffer(cert)).toBe(true);
      // DER-encoded X.509 starts with SEQUENCE tag 0x30
      expect(cert[0]).toBe(0x30);
      expect(cert.length).toBeGreaterThan(300);
    }
  });

  test("APPLE_ENV=sandbox -> SANDBOX, online checks disabled, appAppleId omitted", () => {
    process.env.APPLE_ENV = "sandbox";
    process.env.APPLE_APP_APPLE_ID = "999";
    const cfg = buildVerifierConfig();
    expect(cfg.environment).toBe(Environment.SANDBOX);
    expect(cfg.enableOnlineChecks).toBe(false);
    expect(cfg.appAppleId).toBeUndefined();
  });

  test("APPLE_ENV=production -> PRODUCTION, online checks enabled, appAppleId required", () => {
    process.env.APPLE_ENV = "production";
    process.env.APPLE_APP_APPLE_ID = "6747291340";
    const cfg = buildVerifierConfig();
    expect(cfg.environment).toBe(Environment.PRODUCTION);
    expect(cfg.enableOnlineChecks).toBe(true);
    expect(cfg.appAppleId).toBe(6747291340);
  });

  test("APPLE_ENV=local-testing -> LOCAL_TESTING (used for StoreKit configuration files)", () => {
    process.env.APPLE_ENV = "local-testing";
    const cfg = buildVerifierConfig();
    expect(cfg.environment).toBe(Environment.LOCAL_TESTING);
    expect(cfg.enableOnlineChecks).toBe(false);
  });

  test("APPLE_ENV=local-testing throws 500 in production (defense against misconfig)", () => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.APPLE_ENV = "local-testing";
    try {
      expect(() => buildVerifierConfig()).toThrow(
        /local-testing is forbidden in production/,
      );
    } finally {
      if (priorNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = priorNodeEnv;
      }
    }
  });

  test("APPLE_ENV=sandbox throws 500 in production (prod must verify production JWS only)", () => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.APPLE_ENV = "sandbox";
    try {
      expect(() => buildVerifierConfig()).toThrow(
        /sandbox is forbidden in production/,
      );
    } finally {
      if (priorNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = priorNodeEnv;
      }
    }
  });

  test("missing APPLE_BUNDLE_ID throws 500", () => {
    delete process.env.APPLE_BUNDLE_ID;
    expect(() => buildVerifierConfig()).toThrow(/APPLE_BUNDLE_ID/);
  });

  test("non-numeric APPLE_APP_APPLE_ID in production env throws", () => {
    process.env.APPLE_ENV = "production";
    process.env.APPLE_APP_APPLE_ID = "not-a-number";
    expect(() => buildVerifierConfig()).toThrow(/APPLE_APP_APPLE_ID/);
  });
});

describe("getVerifier", () => {
  let snap: ReturnType<typeof envSnapshot>;

  beforeEach(() => {
    snap = envSnapshot();
    process.env.APPLE_BUNDLE_ID = TEST_BUNDLE_ID;
    process.env.APPLE_ENV = "sandbox";
    resetVerifierForTests();
  });

  afterEach(() => {
    restoreEnv(snap);
    resetVerifierForTests();
  });

  test("caches the verifier across calls", () => {
    const a = getVerifier();
    const b = getVerifier();
    expect(a).toBe(b);
  });

  test("resetVerifierForTests forces a rebuild", () => {
    const a = getVerifier();
    resetVerifierForTests();
    const b = getVerifier();
    expect(a).not.toBe(b);
  });
});

describe("verifyAndDecodeNotification (LOCAL_TESTING fixture)", () => {
  beforeEach(() => {
    resetVerifierForTests();
    installLocalTestingVerifier();
  });

  afterEach(() => {
    resetVerifierForTests();
  });

  test("decodes a SUBSCRIBED notification and exposes data fields", async () => {
    const payload = {
      notificationType: "SUBSCRIBED",
      subtype: "INITIAL_BUY",
      notificationUUID: "11111111-2222-3333-4444-555555555555",
      version: "2.0",
      signedDate: Date.now(),
      data: {
        environment: "LocalTesting",
        appAppleId: 1234,
        bundleId: TEST_BUNDLE_ID,
        bundleVersion: "1",
        signedTransactionInfo: "stub.signed.transaction",
        signedRenewalInfo: "stub.signed.renewal",
        status: 1,
      },
    };
    const signed = await signPayload(payload);

    const decoded = await verifyAndDecodeNotification(signed);

    expect(decoded.notificationType).toBe("SUBSCRIBED");
    expect(decoded.subtype).toBe("INITIAL_BUY");
    expect(decoded.notificationUUID).toBe(payload.notificationUUID);
    expect(decoded.data?.bundleId).toBe(TEST_BUNDLE_ID);
    expect(decoded.data?.environment).toBe("LocalTesting");
    expect(decoded.data?.signedTransactionInfo).toBe("stub.signed.transaction");
  });

  test("decodes a DID_RENEW notification", async () => {
    const signed = await signPayload({
      notificationType: "DID_RENEW",
      notificationUUID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      version: "2.0",
      signedDate: Date.now(),
      data: {
        environment: "LocalTesting",
        bundleId: TEST_BUNDLE_ID,
        signedTransactionInfo: "renewal.signed.transaction",
        signedRenewalInfo: "renewal.signed.renewal",
        status: 1,
      },
    });

    const decoded = await verifyAndDecodeNotification(signed);

    expect(decoded.notificationType).toBe("DID_RENEW");
    expect(decoded.data?.signedTransactionInfo).toBe(
      "renewal.signed.transaction",
    );
  });

  test("rejects a notification with mismatched bundleId", async () => {
    const signed = await signPayload({
      notificationType: "SUBSCRIBED",
      notificationUUID: "33333333-4444-5555-6666-777777777777",
      version: "2.0",
      signedDate: Date.now(),
      data: {
        environment: "LocalTesting",
        bundleId: "com.someone.else",
        signedTransactionInfo: "stub",
        signedRenewalInfo: "stub",
        status: 1,
      },
    });

    await expectRejects(() => verifyAndDecodeNotification(signed));
  });

  test("rejects a notification from a different environment than the verifier", async () => {
    const signed = await signPayload({
      notificationType: "SUBSCRIBED",
      notificationUUID: "44444444-5555-6666-7777-888888888888",
      version: "2.0",
      signedDate: Date.now(),
      data: {
        environment: "Production",
        bundleId: TEST_BUNDLE_ID,
        signedTransactionInfo: "stub",
        signedRenewalInfo: "stub",
        status: 1,
      },
    });

    await expectRejects(() => verifyAndDecodeNotification(signed));
  });

  test("rejects an unsigned (non-JWT) string", async () => {
    await expectRejects(() => verifyAndDecodeNotification("not-a-jws-payload"));
  });

  test("rejects a JWT with the wrong shape", async () => {
    const signed = await signPayload({ hello: "world" });
    await expectRejects(() => verifyAndDecodeNotification(signed));
  });
});

describe("verifyAndDecodeTransaction (LOCAL_TESTING fixture)", () => {
  beforeEach(() => {
    resetVerifierForTests();
    installLocalTestingVerifier();
  });

  afterEach(() => {
    resetVerifierForTests();
  });

  test("decodes a transaction payload with appAccountToken", async () => {
    const appAccountToken = "12345678-1234-1234-1234-123456789012";
    const originalTransactionId = "2000000123456789";
    const signed = await signPayload({
      transactionId: "2000000123456790",
      originalTransactionId,
      bundleId: TEST_BUNDLE_ID,
      productId: "app.convos.subs.builder.monthly",
      subscriptionGroupIdentifier: "21555555",
      purchaseDate: Date.now(),
      originalPurchaseDate: Date.now(),
      expiresDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
      quantity: 1,
      type: "Auto-Renewable Subscription",
      appAccountToken,
      inAppOwnershipType: "PURCHASED",
      signedDate: Date.now(),
      environment: "LocalTesting",
      transactionReason: "PURCHASE",
      storefront: "USA",
      storefrontId: "143441",
      price: 999,
      currency: "USD",
    });

    const decoded = await verifyAndDecodeTransaction(signed);

    expect(decoded.transactionId).toBe("2000000123456790");
    expect(decoded.originalTransactionId).toBe(originalTransactionId);
    expect(decoded.appAccountToken).toBe(appAccountToken);
    expect(decoded.productId).toBe("app.convos.subs.builder.monthly");
    expect(decoded.bundleId).toBe(TEST_BUNDLE_ID);
  });
});
