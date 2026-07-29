import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import {
  AppleEnv,
  BillingProvider,
  SubscriptionPeriod,
  SubscriptionStatus,
} from "@prisma/client";
import express, { json } from "express";
import { importPKCS8, SignJWT } from "jose";
import request from "supertest";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { accountsMeRouter } from "@/api/v2/accounts/accountsMeRouter";
import { authMiddleware } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { consume, getBalance } from "@/payments";
import { attemptAutoReclaim } from "@/subscriptions/auto-reclaim";
import { grantSubscriptionPeriod, subGrantKey } from "@/subscriptions/grants";
import {
  resetVerifierForTests,
  setVerifierForTests,
} from "@/subscriptions/jws-verifier";
import {
  SUBSCRIPTION_TIER_PLUS,
  type AppleVerifyInput,
} from "@/subscriptions/repository";
import { tierGrant } from "@/subscriptions/tier-config";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const TEST_BUNDLE_ID = "app.convos.test";
const DAY_MS = 24 * 60 * 60 * 1000;

const CLAIMANT_ID = "d8975fce-c00b-4dd4-9a44-f2a273813543";
const HOLDER_ID = "5886ede2-6925-4f42-8d35-9301b13d2a85";
const SUBSCRIPTION_ID = "07e60917-f5dc-45b5-8e9c-4ec444b493bc";
const OTX = "560002661368306";
const PERIOD_START = new Date("2026-07-16T00:00:00.000Z");
const PERIOD_END = new Date("2026-08-16T00:00:00.000Z");
const PRODUCT_ID = "app.convos.subs.monthly";
const HOLDER_AAT = "5886ede2-6925-4f42-8d35-9301b13d2a85";
const CLAIMANT_AAT = "d8975fce-c00b-4dd4-9a44-f2a273813543";

const legacyMismatchBody = {
  error: "Subscription belongs to a different account. Contact support.",
  code: "subscription_account_mismatch",
};

const makeApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.use("/v2/accounts/me", authMiddleware, accountsMeRouter);
  return app;
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

let signingPrivateKey: string;

const signTransaction = async (overrides: Record<string, unknown> = {}) => {
  const payload = {
    transactionId: `tx-${randomUUID()}`,
    originalTransactionId: OTX,
    bundleId: TEST_BUNDLE_ID,
    productId: PRODUCT_ID,
    purchaseDate: PERIOD_START.getTime(),
    originalPurchaseDate: PERIOD_START.getTime(),
    expiresDate: PERIOD_END.getTime(),
    type: "Auto-Renewable Subscription",
    appAccountToken: CLAIMANT_AAT,
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

const tokenFor = (accountId: string) =>
  createJwtToken({ deviceId: `dev-${accountId.slice(0, 8)}`, accountId });

const verifyJwsAs = async (accountId: string, jwsRepresentation: string) =>
  request(makeApp())
    .post("/v2/accounts/me/subscription/verify")
    .set("X-Convos-AuthToken", await tokenFor(accountId))
    .send({
      platform: "apple",
      jwsRepresentation,
    });

const verifyAs = async (
  accountId: string,
  overrides: Record<string, unknown> = {},
) => verifyJwsAs(accountId, await signTransaction(overrides));

const seedAccounts = async () => {
  await prisma.account.createMany({
    data: [{ id: HOLDER_ID }, { id: CLAIMANT_ID }],
  });
};

const seedSubscription = async () =>
  prisma.subscription.create({
    data: {
      id: SUBSCRIPTION_ID,
      accountId: HOLDER_ID,
      provider: BillingProvider.apple,
      productId: PRODUCT_ID,
      tier: SUBSCRIPTION_TIER_PLUS,
      period: SubscriptionPeriod.monthly,
      status: SubscriptionStatus.active,
      originalTransactionId: OTX,
      appAccountToken: HOLDER_AAT,
      startedAt: PERIOD_START,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      willRenew: true,
      isInTrial: false,
      environment: AppleEnv.production,
    },
  });

const seedCurrentPeriodGrant = async () => {
  const subscription = await prisma.subscription.findUniqueOrThrow({
    where: { id: SUBSCRIPTION_ID },
  });
  await prisma.$transaction((tx) =>
    grantSubscriptionPeriod(tx, {
      subscription,
      periodStart: PERIOD_START,
    }),
  );
};

const seedVerifyReceipt = async (
  transactionId: string,
  receivedAt = new Date(Date.now() - 8 * DAY_MS),
) =>
  prisma.billingReceipt.create({
    data: {
      subscriptionId: SUBSCRIPTION_ID,
      provider: BillingProvider.apple,
      idempotencyKey: `apple-verify:${transactionId}`,
      transactionId,
      notificationType: "VERIFY",
      signedPayload: "seeded.jws",
      receivedAt,
    },
  });

const countTransferAudits = () =>
  prisma.adminAudit.count({
    where: {
      action: "auto_reclaim_transfer",
      idempotencyKey: { startsWith: `auto_reclaim_apple_${OTX}_` },
    },
  });

const countPeriodGrants = (periodStart: Date) =>
  prisma.creditLedger.count({
    where: {
      accountId: { in: [HOLDER_ID, CLAIMANT_ID] },
      idempotencyKey: subGrantKey(SUBSCRIPTION_ID, periodStart),
      grantKindId: "sub_grant",
    },
  });

const directInput = (): AppleVerifyInput => ({
  provider: BillingProvider.apple,
  accountId: CLAIMANT_ID,
  appAccountToken: CLAIMANT_AAT,
  productId: PRODUCT_ID,
  tier: SUBSCRIPTION_TIER_PLUS,
  period: SubscriptionPeriod.monthly,
  status: SubscriptionStatus.active,
  originalTransactionId: OTX,
  transactionId: `tx-${randomUUID()}`,
  startedAt: PERIOD_START,
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  willRenew: true,
  isInTrial: false,
  environment: AppleEnv.production,
  signedPayload: "signed.jws",
});

const wipe = async () => {
  await prisma.adminAudit.deleteMany({
    where: {
      OR: [
        { accountId: { in: [HOLDER_ID, CLAIMANT_ID] } },
        { idempotencyKey: { startsWith: `auto_reclaim_apple_${OTX}_` } },
      ],
    },
  });
  await prisma.billingReceipt.deleteMany({
    where: {
      OR: [
        { subscriptionId: SUBSCRIPTION_ID },
        { transactionId: { startsWith: "auto-reclaim-test-" } },
      ],
    },
  });
  await prisma.subscription.deleteMany({
    where: {
      OR: [
        { id: SUBSCRIPTION_ID },
        { accountId: { in: [HOLDER_ID, CLAIMANT_ID] } },
      ],
    },
  });
  await prisma.deviceRegistration.deleteMany({
    where: { accountId: { in: [HOLDER_ID, CLAIMANT_ID] } },
  });
  await prisma.creditLedger.deleteMany({
    where: { accountId: { in: [HOLDER_ID, CLAIMANT_ID] } },
  });
  await prisma.userCredits.deleteMany({
    where: { accountId: { in: [HOLDER_ID, CLAIMANT_ID] } },
  });
  await prisma.account.deleteMany({
    where: { id: { in: [HOLDER_ID, CLAIMANT_ID] } },
  });
};

beforeAll(async () => {
  await validateJWTKeys();
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  signingPrivateKey = privateKey;
});

beforeEach(async () => {
  await wipe();
  installLocalTestingVerifier();
  process.env.SUBSCRIPTION_AUTO_RECLAIM_ENABLED = "true";
  delete process.env.SUBSCRIPTION_AUTO_RECLAIM_DORMANCY_DAYS;
  delete process.env.SUBSCRIPTION_AUTO_RECLAIM_COOLDOWN_DAYS;
  delete process.env.SUBSCRIPTION_AUTO_RECLAIM_MAX_JWS_AGE_HOURS;
});

afterEach(async () => {
  await wipe();
  resetVerifierForTests();
  delete process.env.SUBSCRIPTION_AUTO_RECLAIM_ENABLED;
  delete process.env.SUBSCRIPTION_AUTO_RECLAIM_DORMANCY_DAYS;
  delete process.env.SUBSCRIPTION_AUTO_RECLAIM_COOLDOWN_DAYS;
  delete process.env.SUBSCRIPTION_AUTO_RECLAIM_MAX_JWS_AGE_HOURS;
});

describe("subscription verify auto-reclaim", () => {
  test("MONEY-PRINTER GUARD: ping-pong verifies produce exactly one transfer and zero double-minted period grants", async () => {
    await seedAccounts();
    await seedSubscription();
    await seedCurrentPeriodGrant();
    const holderBalanceBefore = await getBalance(HOLDER_ID);

    const claimantJws = await signTransaction({
      appAccountToken: CLAIMANT_AAT,
      transactionId: "auto-reclaim-test-ping-b",
    });
    const first = await verifyJwsAs(CLAIMANT_ID, claimantJws);
    expect(first.status).toBe(200);
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { id: SUBSCRIPTION_ID },
        })
      ).accountId,
    ).toBe(CLAIMANT_ID);
    expect(await countPeriodGrants(PERIOD_START)).toBe(1);
    expect(await getBalance(CLAIMANT_ID)).toBe(0n);

    const pingPong = await verifyAs(HOLDER_ID, {
      appAccountToken: HOLDER_AAT,
      transactionId: "auto-reclaim-test-ping-a",
      signedDate: Date.now(),
    });
    expect(pingPong.status).toBe(409);
    expect(pingPong.body).toEqual(legacyMismatchBody);

    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { id: SUBSCRIPTION_ID },
        })
      ).accountId,
    ).toBe(CLAIMANT_ID);
    expect(await countTransferAudits()).toBe(1);
    expect(await countPeriodGrants(PERIOD_START)).toBe(1);
    expect(await getBalance(CLAIMANT_ID)).toBe(0n);
    expect(await getBalance(HOLDER_ID)).toBe(holderBalanceBefore);
    const transferAudit = await prisma.adminAudit.findFirstOrThrow({
      where: { action: "auto_reclaim_transfer" },
    });
    expect(transferAudit.idempotencyKey).toMatch(
      new RegExp(`^auto_reclaim_apple_${OTX}_${HOLDER_ID}_\\d+$`),
    );

    const identicalReplay = await verifyJwsAs(CLAIMANT_ID, claimantJws);
    expect(identicalReplay.status).toBe(200);
    expect(await countPeriodGrants(PERIOD_START)).toBe(1);
    expect(await getBalance(CLAIMANT_ID)).toBe(0n);

    const freshSamePeriodReplay = await verifyAs(CLAIMANT_ID, {
      appAccountToken: CLAIMANT_AAT,
      transactionId: "auto-reclaim-test-ping-b-fresh",
    });
    expect(freshSamePeriodReplay.status).toBe(200);
    expect(await countPeriodGrants(PERIOD_START)).toBe(1);
    expect(await getBalance(CLAIMANT_ID)).toBe(0n);
  });

  test.each([
    {
      signal: "consume ledger activity",
      seed: async () => {
        await seedCurrentPeriodGrant();
        await consume({
          accountId: HOLDER_ID,
          usdCostMicros: 1_000n,
          idempotencyKey: "consume_auto_reclaim_holder_recent",
          requestId: "auto-reclaim-dormancy",
        });
      },
    },
    {
      signal: "device activity",
      seed: async () => {
        await prisma.deviceRegistration.create({
          data: {
            deviceId: "auto-reclaim-holder-device",
            accountId: HOLDER_ID,
          },
        });
      },
    },
    {
      signal: "VERIFY receipt activity",
      seed: async () => {
        await seedVerifyReceipt("auto-reclaim-test-holder-recent", new Date());
      },
    },
  ])("dormancy gate rejects recent $signal", async ({ seed }) => {
    await seedAccounts();
    await seedSubscription();
    await seed();

    const response = await verifyAs(CLAIMANT_ID, {
      transactionId: `auto-reclaim-test-dormancy-${randomUUID()}`,
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(legacyMismatchBody);
    expect(await countTransferAudits()).toBe(0);
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { id: SUBSCRIPTION_ID },
        })
      ).accountId,
    ).toBe(HOLDER_ID);
  });

  test("Family-Shared ownership never transfers", async () => {
    await seedAccounts();
    await seedSubscription();

    const response = await verifyAs(CLAIMANT_ID, {
      transactionId: "auto-reclaim-test-family",
      inAppOwnershipType: "FAMILY_SHARED",
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(legacyMismatchBody);
    expect(await countTransferAudits()).toBe(0);
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { id: SUBSCRIPTION_ID },
        })
      ).accountId,
    ).toBe(HOLDER_ID);
  });

  test("cooldown rejects a second transfer for the OTX", async () => {
    await seedAccounts();
    await seedSubscription();
    await prisma.adminAudit.create({
      data: {
        accountId: HOLDER_ID,
        actorEmail: "system:auto-reclaim",
        action: "auto_reclaim_transfer",
        deltaCredits: 0n,
        reason: "seeded recent transfer",
        idempotencyKey: `auto_reclaim_apple_${OTX}_seeded`,
        createdAt: new Date(Date.now() - DAY_MS),
      },
    });

    const response = await verifyAs(CLAIMANT_ID, {
      transactionId: "auto-reclaim-test-cooldown",
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(legacyMismatchBody);
    expect(await countTransferAudits()).toBe(1);
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { id: SUBSCRIPTION_ID },
        })
      ).accountId,
    ).toBe(HOLDER_ID);
  });

  test("skip-already-granted canonical period, then grant exactly once next period", async () => {
    await seedAccounts();
    await seedSubscription();
    await seedCurrentPeriodGrant();
    const replayTransactionId = "auto-reclaim-test-canonical-replay";
    await seedVerifyReceipt(replayTransactionId);

    const current = await verifyAs(CLAIMANT_ID, {
      transactionId: replayTransactionId,
    });
    expect(current.status).toBe(200);
    expect(await countPeriodGrants(PERIOD_START)).toBe(1);
    expect(await getBalance(CLAIMANT_ID)).toBe(0n);

    const nextStart = PERIOD_END;
    const nextEnd = new Date("2026-09-16T00:00:00.000Z");
    const renewed = await verifyAs(CLAIMANT_ID, {
      transactionId: "auto-reclaim-test-next-period",
      purchaseDate: nextStart.getTime(),
      expiresDate: nextEnd.getTime(),
      signedDate: Date.now(),
    });

    expect(renewed.status).toBe(200);
    expect(await countPeriodGrants(nextStart)).toBe(1);
    expect(await getBalance(CLAIMANT_ID)).toBe(
      BigInt(
        tierGrant(SUBSCRIPTION_TIER_PLUS, SubscriptionPeriod.monthly).perPeriod,
      ),
    );
  });

  test("pinned-update race returns holder_changed without update or audit", async () => {
    await seedAccounts();
    await seedSubscription();

    const result = await attemptAutoReclaim({
      input: directInput(),
      decoded: {
        inAppOwnershipType: "PURCHASED",
        signedDate: Date.now(),
      },
      expectedHolderAccountId: CLAIMANT_ID,
      log: logger,
    });

    expect(result).toEqual({ eligible: false, reason: "holder_changed" });
    expect(await countTransferAudits()).toBe(0);
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { id: SUBSCRIPTION_ID },
        })
      ).accountId,
    ).toBe(HOLDER_ID);
  });

  test("happy path heals orphan, preserves receipt FK, audits, and grants claimant", async () => {
    await seedAccounts();
    await seedSubscription();
    const originalReceipt = await seedVerifyReceipt(
      "auto-reclaim-test-original-receipt",
    );

    const response = await verifyAs(CLAIMANT_ID, {
      transactionId: "auto-reclaim-test-happy",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      subscription: {
        provider: "apple",
        tier: "plus",
        period: "monthly",
        status: "active",
        productId: PRODUCT_ID,
        currentPeriodEnd: PERIOD_END.toISOString(),
        willRenew: true,
        isInTrial: false,
      },
    });
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { id: SUBSCRIPTION_ID },
        })
      ).accountId,
    ).toBe(CLAIMANT_ID);
    expect(
      (
        await prisma.billingReceipt.findUniqueOrThrow({
          where: { id: originalReceipt.id },
        })
      ).subscriptionId,
    ).toBe(SUBSCRIPTION_ID);
    expect(await countPeriodGrants(PERIOD_START)).toBe(1);
    const claimantGrant = await prisma.creditLedger.findUnique({
      where: {
        accountId_idempotencyKey: {
          accountId: CLAIMANT_ID,
          idempotencyKey: subGrantKey(SUBSCRIPTION_ID, PERIOD_START),
        },
      },
    });
    expect(claimantGrant).not.toBeNull();
    const audit = await prisma.adminAudit.findFirst({
      where: { action: "auto_reclaim_transfer" },
    });
    expect(audit?.actorEmail).toBe("system:auto-reclaim");
    expect(audit?.accountId).toBe(CLAIMANT_ID);
  });

  test("flag off preserves the byte-identical 409 and writes nothing", async () => {
    delete process.env.SUBSCRIPTION_AUTO_RECLAIM_ENABLED;
    await seedAccounts();
    await seedSubscription();

    const response = await verifyAs(CLAIMANT_ID, {
      transactionId: "auto-reclaim-test-disabled",
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(legacyMismatchBody);
    expect(await countTransferAudits()).toBe(0);
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { id: SUBSCRIPTION_ID },
        })
      ).accountId,
    ).toBe(HOLDER_ID);
  });

  test("unexpected auto-reclaim errors fail closed to the legacy 409", async () => {
    await seedAccounts();
    await seedSubscription();
    const activityRead = vi
      .spyOn(prisma.billingReceipt, "findFirst")
      .mockRejectedValueOnce(new Error("forced eligibility read failure"));

    const response = await verifyAs(CLAIMANT_ID, {
      transactionId: "auto-reclaim-test-error",
    });
    activityRead.mockRestore();

    expect(response.status).toBe(409);
    expect(response.body).toEqual(legacyMismatchBody);
    expect(await countTransferAudits()).toBe(0);
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { id: SUBSCRIPTION_ID },
        })
      ).accountId,
    ).toBe(HOLDER_ID);
  });
});
