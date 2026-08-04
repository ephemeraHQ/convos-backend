import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import { BillingProvider } from "@prisma/client";
import express, { json } from "express";
import { importPKCS8, SignJWT } from "jose";
import request from "supertest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { __setAuthActivityStampFailureForTests } from "@/accounts/auth-activity";
import {
  __setClaimAppCheckVerifierForTests,
  __setPendingTransferNotifierForTests,
  claimAppCheckMiddleware,
  subscriptionClaimHandler,
} from "@/api/v2/accounts/handlers/subscription-claim";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { __setClaimCeilingIncrementForTests } from "@/middleware/claimGlobalCeiling";
import { pinoMiddleware } from "@/middleware/pino";
import {
  resetAppleApiClientForTests,
  setAppleApiClientForTests,
} from "@/subscriptions/apple-server-api";
import { __setSettlementEntitlementCheckerForTests } from "@/subscriptions/claim";
import {
  resetPlayApiClientForTests,
  setPlayApiFixtureForTests,
  type SubscriptionPurchaseV2,
} from "@/subscriptions/google-play/play-api";
import { PlaySubscriptionState } from "@/subscriptions/google-play/status";
import { setPubsubVerifierForTests } from "@/subscriptions/google-play/verifier";
import {
  resetVerifierForTests,
  setVerifierForTests,
} from "@/subscriptions/jws-verifier";
import {
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionPeriod,
  SubscriptionStatus,
  type AppleVerifyInput,
  type GooglePlayVerifyInput,
} from "@/subscriptions/repository";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import { setRuntimeConfig } from "@/utils/runtimeConfig";

export const TEST_BUNDLE_ID = "app.convos.test";
export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const PERIOD_START = new Date(Date.now() - 5 * DAY_MS);
export const PERIOD_END = new Date(Date.now() + 25 * DAY_MS);
export const NEXT_PERIOD_END = new Date(PERIOD_END.getTime() + 30 * DAY_MS);
export const PERIOD_CREDITS = 2500n;
export const PRODUCT_ID = "app.convos.subs.monthly";
export const APP_ACCOUNT_TOKEN = "11111111-2222-3333-4444-555555555555";

let signingPrivateKey = "";

export const claimApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.post(
    "/v2/accounts/me/subscription/claim",
    authMiddleware,
    requireAccount,
    claimAppCheckMiddleware,
    subscriptionClaimHandler,
  );
  return app;
};

export const newAccount = async (lastAuthAt?: Date | null) => {
  const account = await prisma.account.create({
    data: {
      lastAuthAt:
        lastAuthAt === undefined ? new Date(Date.now() - HOUR_MS) : lastAuthAt,
    },
  });
  return account.id;
};

export const tokenFor = (accountId: string) =>
  createJwtToken({ deviceId: `dev-${accountId.slice(0, 8)}`, accountId });

export const signTransaction = async (
  transactionId: string,
  overrides: Record<string, unknown> = {},
) => {
  const payload = {
    transactionId,
    originalTransactionId: transactionId,
    bundleId: TEST_BUNDLE_ID,
    productId: PRODUCT_ID,
    purchaseDate: PERIOD_START.getTime(),
    originalPurchaseDate: PERIOD_START.getTime(),
    expiresDate: PERIOD_END.getTime(),
    type: "Auto-Renewable Subscription",
    appAccountToken: APP_ACCOUNT_TOKEN,
    inAppOwnershipType: "PURCHASED",
    signedDate: Date.now(),
    environment: "LocalTesting",
    ...overrides,
  };
  const privateKey = await importPKCS8(signingPrivateKey, "ES256");
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256" })
    .sign(privateKey);
};

export const installLocalTestingVerifier = () => {
  setVerifierForTests(
    new SignedDataVerifier(
      [],
      false,
      Environment.LOCAL_TESTING,
      TEST_BUNDLE_ID,
      1234,
    ),
  );
};

/** Signed JWSRenewalInfo, e.g. for billing-grace status items. */
export const signRenewalInfo = async (
  overrides: Record<string, unknown> = {},
) => {
  const payload = {
    autoRenewProductId: PRODUCT_ID,
    autoRenewStatus: 1,
    productId: PRODUCT_ID,
    signedDate: Date.now(),
    environment: "LocalTesting",
    ...overrides,
  };
  const privateKey = await importPKCS8(signingPrivateKey, "ES256");
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256" })
    .sign(privateKey);
};

export type AppleStatus = {
  status: number;
  signedLatest: string;
  signedRenewal?: string;
};

export const appleStatuses = (args: AppleStatus & { otx: string }) => ({
  data: [
    {
      lastTransactions: [
        {
          originalTransactionId: args.otx,
          status: args.status,
          signedTransactionInfo: args.signedLatest,
          ...(args.signedRenewal
            ? { signedRenewalInfo: args.signedRenewal }
            : {}),
        },
      ],
    },
  ],
});

export const installAppleStatusMap = (
  statuses: Partial<Record<string, AppleStatus>>,
) => {
  setAppleApiClientForTests({
    getAllSubscriptionStatuses: (otx: string) => {
      const status = statuses[otx];
      if (!status) return Promise.reject(new Error(`no fixture for ${otx}`));
      return Promise.resolve(appleStatuses({ otx, ...status }));
    },
  } as never);
};

export const installAppleStatuses = (args: AppleStatus & { otx: string }) => {
  installAppleStatusMap({ [args.otx]: args });
};

export const appleInput = (
  accountId: string,
  otx: string,
  overrides: Partial<AppleVerifyInput> = {},
): AppleVerifyInput => ({
  provider: BillingProvider.apple,
  accountId,
  appAccountToken: APP_ACCOUNT_TOKEN,
  productId: PRODUCT_ID,
  tier: SUBSCRIPTION_TIER_PLUS,
  period: SubscriptionPeriod.monthly,
  status: SubscriptionStatus.active,
  originalTransactionId: otx,
  transactionId: otx,
  startedAt: PERIOD_START,
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  willRenew: true,
  isInTrial: false,
  environment: "sandbox",
  signedPayload: "jws-test-payload",
  ...overrides,
});

export const playInput = (
  accountId: string,
  purchaseToken: string,
  overrides: Partial<GooglePlayVerifyInput> = {},
): GooglePlayVerifyInput => ({
  provider: BillingProvider.googlePlay,
  accountId,
  obfuscatedAccountId: `oid-${purchaseToken}`,
  productId: PRODUCT_ID,
  tier: SUBSCRIPTION_TIER_PLUS,
  period: SubscriptionPeriod.monthly,
  status: SubscriptionStatus.active,
  purchaseToken,
  linkedPurchaseToken: null,
  playOrderId: `GPA.${purchaseToken}..0`,
  startedAt: PERIOD_START,
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  willRenew: true,
  isInTrial: false,
  signedPayload: "{}",
  ...overrides,
});

export const playPurchase = (args: {
  latestOrderId: string | null;
  expiry?: Date;
  state?: string;
  linkedPurchaseToken?: string | null;
}): SubscriptionPurchaseV2 => ({
  subscriptionState: args.state ?? PlaySubscriptionState.active,
  startTime: PERIOD_START.toISOString(),
  ...(args.latestOrderId === null ? {} : { latestOrderId: args.latestOrderId }),
  ...(args.linkedPurchaseToken
    ? { linkedPurchaseToken: args.linkedPurchaseToken }
    : {}),
  lineItems: [
    {
      productId: PRODUCT_ID,
      expiryTime: (args.expiry ?? PERIOD_END).toISOString(),
      autoRenewingPlan: { autoRenewEnabled: true },
    },
  ],
  externalAccountIdentifiers: { obfuscatedExternalAccountId: "obf-test" },
});

export const passAppCheck = () => {
  __setClaimAppCheckVerifierForTests(() => Promise.resolve());
};

export const appleClaimRequest = async (
  accountId: string,
  jws: string,
  appCheckToken = `limited-${randomUUID()}`,
) =>
  request(claimApp())
    .post("/v2/accounts/me/subscription/claim")
    .set("X-Convos-AuthToken", await tokenFor(accountId))
    .set("X-Firebase-AppCheck", appCheckToken)
    .send({ platform: "apple", jwsRepresentation: jws });

export const playClaimRequest = async (
  accountId: string,
  purchaseToken: string,
) =>
  request(claimApp())
    .post("/v2/accounts/me/subscription/claim")
    .set("X-Convos-AuthToken", await tokenFor(accountId))
    .set("X-Firebase-AppCheck", `limited-${randomUUID()}`)
    .send({ platform: "googlePlay", purchaseToken, productId: PRODUCT_ID });

export const wipeReclaimState = async () => {
  __setClaimAppCheckVerifierForTests(null);
  __setClaimCeilingIncrementForTests(null);
  __setPendingTransferNotifierForTests(null);
  __setSettlementEntitlementCheckerForTests(null);
  __setAuthActivityStampFailureForTests(null);
  delete process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED;
  delete process.env.SUBSCRIPTION_CLAIM_GOOGLE_ENABLED;
  delete process.env.CLAIM_CONTEST_WINDOW_HOURS;
  resetVerifierForTests();
  resetAppleApiClientForTests();
  resetPlayApiClientForTests();
  setPlayApiFixtureForTests(null);
  setPubsubVerifierForTests(null);
  await setRuntimeConfig("app_attest_enabled", "true");
  await prisma.rateLimitCounter.deleteMany();
  await prisma.deletionTask.deleteMany();
  await prisma.deletionRecord.deleteMany();
  await prisma.deletedIdentity.deleteMany();
  await prisma.lineageQuarantine.deleteMany();
  await prisma.subscriptionDriftSchedule.deleteMany();
  await prisma.subscriptionTransfer.deleteMany();
  await prisma.lineagePeriodCustody.deleteMany();
  await prisma.lineagePeriodGrant.deleteMany();
  await prisma.lineageTokenAlias.deleteMany();
  await prisma.subscriptionLineage.deleteMany();
  await prisma.adminAudit.deleteMany();
  await prisma.billingReceipt.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.creditLedger.deleteMany();
  await prisma.userCredits.deleteMany();
  await prisma.deviceRegistration.deleteMany();
  await prisma.authMethod.deleteMany();
  await prisma.account.deleteMany({
    where: { id: { not: "48a05ef4-4a71-57a0-957f-a3d410992b31" } },
  });
};

export const installReclaimHooks = () => {
  let previousLocalTesting: string | undefined;

  beforeAll(async () => {
    await validateJWTKeys();
    previousLocalTesting = process.env.LOCAL_TESTING;
    process.env.LOCAL_TESTING = "1";
    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    signingPrivateKey = privateKey;
  });

  afterAll(() => {
    if (previousLocalTesting === undefined) {
      delete process.env.LOCAL_TESTING;
    } else {
      process.env.LOCAL_TESTING = previousLocalTesting;
    }
  });

  afterEach(wipeReclaimState);
};
