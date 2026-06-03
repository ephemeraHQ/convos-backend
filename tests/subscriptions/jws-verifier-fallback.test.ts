import type { Environment } from "@apple/app-store-server-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

// Replace the Apple SignedDataVerifier with a stub whose behavior depends on
// the environment it was constructed for: a Production-configured verifier
// rejects with INVALID_ENVIRONMENT (as it would for a Sandbox/TestFlight
// receipt), while a Sandbox-configured verifier accepts. This lets us exercise
// the environment-fallback path without real Apple-signed receipts. The real
// Environment / VerificationException / VerificationStatus exports are kept.
vi.mock("@apple/app-store-server-library", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { Environment, VerificationException, VerificationStatus } = actual as {
    Environment: { PRODUCTION: Environment };
    VerificationException: new (status: number) => Error;
    VerificationStatus: { INVALID_ENVIRONMENT: number };
  };

  class FakeSignedDataVerifier {
    constructor(
      _certs: unknown,
      _online: boolean,
      readonly environment: Environment,
    ) {}

    private decode(signed: string, kind: "tx" | "notif") {
      if (this.environment === Environment.PRODUCTION) {
        // Chain verified, but the receipt was signed for another environment.
        throw new VerificationException(VerificationStatus.INVALID_ENVIRONMENT);
      }
      return kind === "tx"
        ? { transactionId: signed, environment: "Sandbox" }
        : { notificationUUID: signed, data: { environment: "Sandbox" } };
    }

    verifyAndDecodeTransaction(signed: string) {
      return Promise.resolve(this.decode(signed, "tx"));
    }

    verifyAndDecodeNotification(signed: string) {
      return Promise.resolve(this.decode(signed, "notif"));
    }
  }

  return { ...actual, SignedDataVerifier: FakeSignedDataVerifier };
});

// Imported after the mock is registered (vi.mock is hoisted).
const { resetVerifierForTests, verifyAndDecodeTransaction } =
  await import("@/subscriptions/jws-verifier");

type EnvSnapshot = Record<
  "APPLE_ENV" | "APPLE_BUNDLE_ID" | "APPLE_APP_APPLE_ID" | "NODE_ENV",
  string | undefined
>;

const snapshot = (): EnvSnapshot => ({
  APPLE_ENV: process.env.APPLE_ENV,
  APPLE_BUNDLE_ID: process.env.APPLE_BUNDLE_ID,
  APPLE_APP_APPLE_ID: process.env.APPLE_APP_APPLE_ID,
  NODE_ENV: process.env.NODE_ENV,
});

const restore = (snap: EnvSnapshot) => {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
};

describe("verifyAndDecodeTransaction — environment fallback", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = snapshot();
    process.env.APPLE_BUNDLE_ID = "app.convos.test";
    process.env.APPLE_APP_APPLE_ID = "6747291340";
    resetVerifierForTests();
  });

  afterEach(() => {
    restore(snap);
    resetVerifierForTests();
  });

  test("Production primary falls back to Sandbox on INVALID_ENVIRONMENT", async () => {
    process.env.APPLE_ENV = "production";
    // Production verifier throws INVALID_ENVIRONMENT; fallback to Sandbox wins.
    const decoded = await verifyAndDecodeTransaction("sandbox.receipt");
    expect(decoded.transactionId).toBe("sandbox.receipt");
    expect(decoded.environment).toBe("Sandbox");
  });

  test("Sandbox primary verifies directly with no fallback", async () => {
    process.env.APPLE_ENV = "sandbox";
    const decoded = await verifyAndDecodeTransaction("sandbox.receipt");
    expect(decoded.transactionId).toBe("sandbox.receipt");
  });
});
