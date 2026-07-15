import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import { BillingProvider, Prisma } from "@prisma/client";
import express, { json } from "express";
import { importPKCS8, SignJWT } from "jose";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { deleteAccount } from "@/accounts/deletion/service";
import {
  IdentityBarredError,
  upsertAuthMethodAndAccount,
} from "@/accounts/repository";
import {
  __setClaimAppCheckVerifierForTests,
  __setPendingTransferNotifierForTests,
  claimAppCheckMiddleware,
  subscriptionClaimHandler,
} from "@/api/v2/accounts/handlers/subscription-claim";
import { subscriptionVerifyHandler } from "@/api/v2/accounts/handlers/subscription-verify";
import { googlePlayWebhookRouter } from "@/api/v2/subscriptions/google-play-webhook.router";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { consume, getBalance } from "@/payments";
import {
  resetAppleApiClientForTests,
  setAppleApiClientForTests,
} from "@/subscriptions/apple-server-api";
import { settlePendingTransfers } from "@/subscriptions/claim";
import { PlayNotificationType } from "@/subscriptions/google-play/notification-mapping";
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
  LineageUnresolvedError,
  resolveOrCreateGoogleLineage,
} from "@/subscriptions/lineage";
import {
  applyNotification,
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionPeriod,
  SubscriptionStatus,
  upsertFromVerify,
  type AppleVerifyInput,
  type GooglePlayApplyNotificationInput,
  type GooglePlayVerifyInput,
} from "@/subscriptions/repository";
import {
  isRetryableTxConflict,
  withDeadlockRetry,
} from "@/utils/deadlock-retry";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import { setRuntimeConfig } from "@/utils/runtimeConfig";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const TEST_BUNDLE_ID = "app.convos.test";
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_START = new Date(Date.now() - 5 * DAY_MS);
const PERIOD_END = new Date(Date.now() + 25 * DAY_MS);
const NEXT_PERIOD_END = new Date(PERIOD_END.getTime() + 30 * DAY_MS);
const PERIOD_CREDITS = 2500n;

const claimApp = () => {
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

const verifyApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.post(
    "/v2/accounts/me/subscription/verify",
    authMiddleware,
    requireAccount,
    subscriptionVerifyHandler,
  );
  return app;
};

const rtdnApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.use("/v2/webhooks/google-play", googlePlayWebhookRouter);
  return app;
};

let signingPrivateKey: string;
let previousLocalTesting: string | undefined;

// lastAuthAt is backdated: real accounts always carry a stamp (mint +
// migration backfill), and settlement defensively treats null as a veto.
const newAccount = async () => {
  const account = await prisma.account.create({
    data: { lastAuthAt: new Date(Date.now() - 60 * 60 * 1000) },
  });
  return account.id;
};

const tokenFor = (accountId: string) =>
  createJwtToken({ deviceId: `dev-${accountId.slice(0, 8)}`, accountId });

const signTransaction = async (overrides: Record<string, unknown> = {}) => {
  const payload = {
    transactionId: "7000000000000001",
    originalTransactionId: "7000000000000001",
    bundleId: TEST_BUNDLE_ID,
    productId: "app.convos.subs.monthly",
    purchaseDate: PERIOD_START.getTime(),
    originalPurchaseDate: PERIOD_START.getTime(),
    expiresDate: PERIOD_END.getTime(),
    type: "Auto-Renewable Subscription",
    appAccountToken: "11111111-2222-3333-4444-555555555555",
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

const installLocalTestingVerifier = () => {
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

/** Per-OTX Apple statuses fake (supports several lineages in one test). */
const installAppleStatusMap = (
  map: Record<string, { status: number; signedLatest: string }>,
) => {
  setAppleApiClientForTests({
    getAllSubscriptionStatuses: (otx: string) => {
      const entry = map[otx] as
        | { status: number; signedLatest: string }
        | undefined;
      if (!entry) return Promise.reject(new Error(`no fixture for ${otx}`));
      return Promise.resolve({
        data: [
          {
            lastTransactions: [
              {
                originalTransactionId: otx,
                status: entry.status,
                signedTransactionInfo: entry.signedLatest,
              },
            ],
          },
        ],
      });
    },
  } as never);
};

const appleInput = (
  accountId: string,
  otx: string,
  appAccountToken = "11111111-2222-3333-4444-555555555555",
): AppleVerifyInput => ({
  provider: BillingProvider.apple,
  accountId,
  appAccountToken,
  productId: "app.convos.subs.monthly",
  tier: SUBSCRIPTION_TIER_PLUS,
  period: SubscriptionPeriod.monthly,
  status: SubscriptionStatus.active,
  originalTransactionId: otx,
  // Same id the claim JWS presents as Apple's latest transaction: the
  // funding event and the claim proof name the same charge, as in
  // production when no renewal happened in between.
  transactionId: otx,
  startedAt: PERIOD_START,
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  willRenew: true,
  isInTrial: false,
  environment: "sandbox",
  signedPayload: "jws-test-payload",
});

const playInput = (
  accountId: string,
  purchaseToken: string,
  overrides: Partial<GooglePlayVerifyInput> = {},
): GooglePlayVerifyInput => ({
  provider: BillingProvider.googlePlay,
  accountId,
  obfuscatedAccountId: `oid-${purchaseToken}`,
  productId: "app.convos.subs.monthly",
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

/** Google renewal notification: startTime UNCHANGED, expiry + order advance. */
const playRenewalNotification = (
  purchaseToken: string,
  playOrderId: string,
  periodEnd: Date,
): GooglePlayApplyNotificationInput => ({
  provider: BillingProvider.googlePlay,
  purchaseToken,
  linkedPurchaseToken: null,
  playOrderId,
  messageId: `msg-${randomUUID()}`,
  notificationType: "PLAY_2",
  notificationSubtype: null,
  signedPayload: "{}",
  update: {
    status: SubscriptionStatus.active,
    tier: SUBSCRIPTION_TIER_PLUS,
    productId: "app.convos.subs.monthly",
    // Google reports the lifetime startTime — it never advances.
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: periodEnd,
    willRenew: true,
  },
});

const wipe = async () => {
  __setClaimAppCheckVerifierForTests(null);
  __setPendingTransferNotifierForTests(null);
  resetVerifierForTests();
  resetAppleApiClientForTests();
  resetPlayApiClientForTests();
  setPlayApiFixtureForTests(null);
  setPubsubVerifierForTests(null);
  delete process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED;
  delete process.env.CLAIM_CONTEST_WINDOW_HOURS;
  await setRuntimeConfig("app_attest_enabled", "true");
  await prisma.deletionTask.deleteMany();
  await prisma.deletionRecord.deleteMany();
  await prisma.deletedIdentity.deleteMany();
  await prisma.lineageQuarantine.deleteMany();
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

afterEach(wipe);

type ClaimBody = { code?: string; reason?: string };

const claimRequest = async (accountId: string, jws: string) =>
  request(claimApp())
    .post("/v2/accounts/me/subscription/claim")
    .set("X-Convos-AuthToken", await tokenFor(accountId))
    .set("X-Firebase-AppCheck", `limited-${randomUUID()}`)
    .send({ platform: "apple", jwsRepresentation: jws });

describe("app_attest_enabled=false closes claim completely", () => {
  test("a VALID limited-use token is still rejected while the flag is false", async () => {
    await setRuntimeConfig("app_attest_enabled", "false");
    // The verifier would accept the token — the flag must win.
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    installLocalTestingVerifier();
    const accountId = await newAccount();
    const jws = await signTransaction();
    const res = await claimRequest(accountId, jws);
    expect(res.status).toBe(403);
    expect((res.body as ClaimBody).code).toBe("app_check_required");
  });
});

describe("google renewal accounting (order identity, not lifetime startTime)", () => {
  test("webhook renewal with unchanged startTime and a new latestOrderId grants", async () => {
    const accountId = await newAccount();
    const token = "renewal-token-1";
    await upsertFromVerify(playInput(accountId, token));
    expect(await getBalance(accountId)).toBe(PERIOD_CREDITS);

    const renewal = playRenewalNotification(
      token,
      `GPA.${token}..1`,
      NEXT_PERIOD_END,
    );
    const result = await applyNotification(renewal);
    expect(result.kind).toBe("applied");
    expect(await getBalance(accountId)).toBe(2n * PERIOD_CREDITS);

    // Two funded periods: two registry rows, two custody rows, and the
    // renewal custody window starts where the previous period ended.
    expect(await prisma.lineagePeriodGrant.count()).toBe(2);
    const custody = await prisma.lineagePeriodCustody.findMany({
      orderBy: { periodEnd: "asc" },
    });
    expect(custody).toHaveLength(2);
    expect(custody[1].periodStart.getTime()).toBe(PERIOD_END.getTime());

    // Replaying the SAME order (fresh messageId) funds nothing.
    const replay = await applyNotification(
      playRenewalNotification(token, `GPA.${token}..1`, NEXT_PERIOD_END),
    );
    expect(replay.kind).toBe("applied");
    expect(await getBalance(accountId)).toBe(2n * PERIOD_CREDITS);
    expect(await prisma.lineagePeriodGrant.count()).toBe(2);
  });

  test("verify-path renewal with unchanged startTime grants once", async () => {
    const accountId = await newAccount();
    const token = "renewal-token-2";
    await upsertFromVerify(playInput(accountId, token));

    const renewed = playInput(accountId, token, {
      playOrderId: `GPA.${token}..1`,
      currentPeriodStart: PERIOD_START, // lifetime start, unchanged
      currentPeriodEnd: NEXT_PERIOD_END,
    });
    await upsertFromVerify(renewed);
    expect(await getBalance(accountId)).toBe(2n * PERIOD_CREDITS);

    // Exact re-verify of the same order: receipt replay, no third grant.
    await upsertFromVerify(renewed);
    expect(await getBalance(accountId)).toBe(2n * PERIOD_CREDITS);
  });

  test("an upgrade event (new order id, same window) records no new funding", async () => {
    const accountId = await newAccount();
    const token = "upgrade-token-1";
    await upsertFromVerify(playInput(accountId, token));
    await upsertFromVerify(
      playInput(accountId, `${token}-rotated`, {
        linkedPurchaseToken: token,
        playOrderId: `GPA.${token}..upgrade`,
        currentPeriodEnd: PERIOD_END, // window did not advance
      }),
    );
    expect(await getBalance(accountId)).toBe(PERIOD_CREDITS);
    expect(await prisma.lineagePeriodCustody.count()).toBe(1);
    expect(await prisma.subscriptionLineage.count()).toBe(1);
  });
});

describe("keyless google events fail closed", () => {
  const keylessPurchase = (): SubscriptionPurchaseV2 => ({
    subscriptionState: PlaySubscriptionState.active,
    startTime: PERIOD_START.toISOString(),
    // latestOrderId deliberately absent.
    lineItems: [
      {
        productId: "app.convos.subs.monthly",
        expiryTime: PERIOD_END.toISOString(),
        autoRenewingPlan: { autoRenewEnabled: true },
      },
    ],
    externalAccountIdentifiers: { obfuscatedExternalAccountId: "obf-keyless" },
  });

  test("verify: no latestOrderId -> 502, parked in quarantine, no grant", async () => {
    setPlayApiFixtureForTests(() => keylessPurchase());
    const accountId = await newAccount();
    const res = await request(verifyApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", await tokenFor(accountId))
      .send({
        platform: "googlePlay",
        purchaseToken: "keyless-1",
        productId: "app.convos.subs.monthly",
      });
    expect(res.status).toBe(502);
    const parked = await prisma.lineageQuarantine.findFirst({
      where: { token: "keyless-1" },
    });
    expect(parked?.reason).toBe("missing_latest_order_id");
    expect(await getBalance(accountId)).toBe(0n);
    expect(await prisma.subscription.count()).toBe(0);
  });

  test("rtdn: no latestOrderId -> acked as parked, quarantined, nothing funded", async () => {
    setPlayApiFixtureForTests(() => keylessPurchase());
    setPubsubVerifierForTests(() => undefined);
    const notification = {
      version: "1.0",
      notificationType: PlayNotificationType.renewed,
      purchaseToken: "keyless-2",
    };
    const res = await request(rtdnApp())
      .post("/v2/webhooks/google-play/rtdn")
      .send({
        message: {
          messageId: `msg-${randomUUID()}`,
          data: Buffer.from(
            JSON.stringify({ subscriptionNotification: notification }),
          ).toString("base64"),
        },
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, kind: "keyless_parked" });
    const parked = await prisma.lineageQuarantine.findFirst({
      where: { token: "keyless-2" },
    });
    expect(parked?.reason).toBe("missing_latest_order_id");
    expect(await prisma.lineagePeriodGrant.count()).toBe(0);
  });
});

describe("terminal events while tombstoned invalidate their exact escrow", () => {
  test("refund of a tombstoned renewal zeroes that period's escrow only", async () => {
    installLocalTestingVerifier();
    const owner = await newAccount();
    const otx = "7000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    await deleteAccount({ accountId: owner, operationId: randomUUID() });

    // Renewal while tombstoned funds escrow for the next period.
    const renewal = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otx,
      transactionId: "renewal-tx-r3",
      notificationUUID: randomUUID(),
      notificationType: "DID_RENEW",
      signedPayload: "jws",
      update: {
        status: SubscriptionStatus.active,
        productId: "app.convos.subs.monthly",
        tier: SUBSCRIPTION_TIER_PLUS,
        currentPeriodStart: PERIOD_END,
        currentPeriodEnd: NEXT_PERIOD_END,
        willRenew: true,
      },
    });
    expect(renewal.kind).toBe("tombstoned");
    const renewalEscrow = await prisma.lineagePeriodCustody.findFirst({
      where: { providerPeriodKey: "apple_txn_renewal-tx-r3" },
    });
    expect(renewalEscrow?.state).toBe("escrow");
    expect(renewalEscrow?.remainderCap).toBe(PERIOD_CREDITS);

    // The refund of that renewal arrives while still tombstoned: its escrow
    // is invalidated so no later restoration can release refunded value.
    const refund = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otx,
      transactionId: "renewal-tx-r3",
      notificationUUID: randomUUID(),
      notificationType: "REVOKE",
      signedPayload: "jws",
      update: {
        status: SubscriptionStatus.revoked,
        willRenew: false,
        cancelledAt: new Date(),
        currentPeriodEnd: NEXT_PERIOD_END,
      },
    });
    expect(refund.kind).toBe("tombstoned");
    const afterRefund = await prisma.lineagePeriodCustody.findFirst({
      where: { id: renewalEscrow?.id ?? "" },
    });
    expect(afterRefund?.state).toBe("invalidated");
    expect(afterRefund?.remainderCap).toBe(0n);

    // Late-event isolation: the earlier deletion escrow is untouched.
    const deletionEscrow = await prisma.lineagePeriodCustody.findFirst({
      where: { state: "escrow" },
    });
    expect(deletionEscrow).not.toBeNull();
    expect(deletionEscrow?.remainderCap).toBe(PERIOD_CREDITS);
  });
});

describe("one-shot undo under a real race", () => {
  test("concurrent undos by the previous owner commit exactly one undo journal", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "0";
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const claimer = await newAccount();
    const otx = "7000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    const jws = await signTransaction();
    installAppleStatusMap({ [otx]: { status: 1, signedLatest: jws } });
    expect((await claimRequest(claimer, jws)).status).toBe(200);

    const [a, b] = await Promise.all([
      claimRequest(owner, jws),
      claimRequest(owner, jws),
    ]);
    // Winner undoes; loser converges as an idempotent replay (owner already
    // holds the row) or an undo_consumed rejection — never a second undo.
    for (const res of [a, b]) {
      expect([200, 409]).toContain(res.status);
    }
    expect(
      await prisma.subscriptionTransfer.count({ where: { kind: "undo" } }),
    ).toBe(1);
    const transfer = await prisma.subscriptionTransfer.findFirstOrThrow({
      where: { kind: "transfer" },
    });
    expect(transfer.undoneByTransferId).not.toBeNull();
    const row = await prisma.subscription.findFirstOrThrow({
      where: { originalTransactionId: otx },
    });
    expect(row.accountId).toBe(owner);

    // The undo journal row is never itself an undo target: the claimer's
    // "undo of the undo" is rejected (post-undo freeze; and undo rows carry
    // no undo deadline).
    const undoRow = await prisma.subscriptionTransfer.findFirstOrThrow({
      where: { kind: "undo" },
    });
    expect(undoRow.undoDeadlineAt).toBeNull();
    const claimBack = await claimRequest(claimer, jws);
    expect(claimBack.status).toBe(409);
    expect((claimBack.body as ClaimBody).reason).toBe("transfer_frozen");
  });
});

describe("contest-window settlement rechecks the provider", () => {
  test("entitlement revoked during the window cancels the pending transfer", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "72";
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    __setPendingTransferNotifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const claimer = await newAccount();
    const otx = "7000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    const jws = await signTransaction();
    installAppleStatusMap({ [otx]: { status: 1, signedLatest: jws } });

    expect((await claimRequest(claimer, jws)).status).toBe(202);

    // The provider revokes inside the window; settlement's execution-time
    // recheck must cancel instead of executing the stored transfer.
    installAppleStatusMap({ [otx]: { status: 2, signedLatest: jws } });
    await prisma.subscriptionTransfer.updateMany({
      where: { status: "pending" },
      data: { contestEndsAt: new Date(Date.now() - 1000) },
    });
    const settled = await settlePendingTransfers();
    expect(settled.cancelled).toBe(1);
    expect(settled.committed).toBe(0);
    const row = await prisma.subscription.findFirstOrThrow({
      where: { originalTransactionId: otx },
    });
    expect(row.accountId).toBe(owner);
  });

  test("provider unreachable defers settlement (row stays pending)", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "72";
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    __setPendingTransferNotifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const claimer = await newAccount();
    const otx = "7000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    const jws = await signTransaction();
    installAppleStatusMap({ [otx]: { status: 1, signedLatest: jws } });
    expect((await claimRequest(claimer, jws)).status).toBe(202);

    resetAppleApiClientForTests(); // provider calls now fail
    await prisma.subscriptionTransfer.updateMany({
      where: { status: "pending" },
      data: { contestEndsAt: new Date(Date.now() - 1000) },
    });
    const settled = await settlePendingTransfers();
    expect(settled).toEqual({ committed: 0, cancelled: 0 });
    expect(
      await prisma.subscriptionTransfer.count({ where: { status: "pending" } }),
    ).toBe(1);
  });

  test("null lastAuthAt on the old account is a defensive veto", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "72";
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    __setPendingTransferNotifierForTests(() => Promise.resolve());
    // Owner with NO lastAuthAt (direct create) — settlement must not treat
    // the unknown as silence-equals-consent.
    const owner = (await prisma.account.create({ data: {} })).id;
    const claimer = await newAccount();
    const otx = "7000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    const jws = await signTransaction();
    installAppleStatusMap({ [otx]: { status: 1, signedLatest: jws } });
    expect((await claimRequest(claimer, jws)).status).toBe(202);

    await prisma.subscriptionTransfer.updateMany({
      where: { status: "pending" },
      data: { contestEndsAt: new Date(Date.now() - 1000) },
    });
    const settled = await settlePendingTransfers();
    expect(settled.cancelled).toBe(1);
    expect(settled.committed).toBe(0);
  });
});

describe("deadlock retry", () => {
  test("withDeadlockRetry retries bounded on 40P01/40001-shaped failures", async () => {
    let calls = 0;
    const flaky = () => {
      calls += 1;
      if (calls < 3) {
        throw new Prisma.PrismaClientKnownRequestError(
          "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
          { code: "P2034", clientVersion: "test" },
        );
      }
      return Promise.resolve("ok");
    };
    await expect(withDeadlockRetry(flaky)).resolves.toBe("ok");
    expect(calls).toBe(3);

    // Bounded: a persistent deadlock surfaces after the attempt budget.
    let always = 0;
    await expect(
      withDeadlockRetry(
        () => {
          always += 1;
          return Promise.reject(new Error("40P01: deadlock detected"));
        },
        { attempts: 3 },
      ),
    ).rejects.toThrow("deadlock detected");
    expect(always).toBe(3);

    // Non-retryable errors are thrown immediately.
    let once = 0;
    await expect(
      withDeadlockRetry(() => {
        once += 1;
        return Promise.reject(new Error("something else"));
      }),
    ).rejects.toThrow("something else");
    expect(once).toBe(1);
    expect(isRetryableTxConflict(new Error("40001"))).toBe(true);
    expect(isRetryableTxConflict(new Error("boring"))).toBe(false);
  });

  test("opposite-direction transfers across two lineages converge (sorted wallet prelock)", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "0";
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const accountA = await newAccount();
    const accountB = await newAccount();
    const otx1 = "7000000000000011";
    const otx2 = "7000000000000012";
    await upsertFromVerify(
      appleInput(accountA, otx1, "11111111-2222-3333-4444-000000000001"),
    );
    await upsertFromVerify(
      appleInput(accountB, otx2, "11111111-2222-3333-4444-000000000002"),
    );
    const jws1 = await signTransaction({
      transactionId: otx1,
      originalTransactionId: otx1,
    });
    const jws2 = await signTransaction({
      transactionId: otx2,
      originalTransactionId: otx2,
    });
    installAppleStatusMap({
      [otx1]: { status: 1, signedLatest: jws1 },
      [otx2]: { status: 1, signedLatest: jws2 },
    });

    // L1: A -> B while L2: B -> A, concurrently. Without sorted wallet
    // prelocks this is the textbook AB-BA wallet deadlock.
    const [r1, r2] = await Promise.all([
      claimRequest(accountB, jws1),
      claimRequest(accountA, jws2),
    ]);
    expect(
      [r1.status, r2.status],
      `${JSON.stringify(r1.body)} / ${JSON.stringify(r2.body)}`,
    ).toEqual([200, 200]);
    // Conservation: each wallet ends with exactly the other lineage's period.
    expect(await getBalance(accountA)).toBe(PERIOD_CREDITS);
    expect(await getBalance(accountB)).toBe(PERIOD_CREDITS);
  });
});

describe("cumulative custody cap across the full lifecycle", () => {
  test("transfer -> spend -> undo -> delete -> restore never exceeds one allotment", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "0";
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const claimerB = await newAccount();
    const claimerC = await newAccount();
    const otx = "7000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    const jws = await signTransaction();
    installAppleStatusMap({ [otx]: { status: 1, signedLatest: jws } });

    const capAfter = async (): Promise<bigint> => {
      const custody = await prisma.lineagePeriodCustody.findFirstOrThrow({
        orderBy: { periodEnd: "desc" },
      });
      return custody.remainderCap;
    };

    const caps: bigint[] = [await capAfter()];

    // Transfer to B, B spends 1000, owner undoes (recovers the remainder).
    expect((await claimRequest(claimerB, jws)).status).toBe(200);
    caps.push(await capAfter());
    await consume({
      accountId: claimerB,
      usdCostMicros: 500_000n,
      idempotencyKey: `burn_${claimerB}`,
      requestId: "burn",
    });
    expect((await claimRequest(owner, jws)).status).toBe(200);
    caps.push(await capAfter());

    // Owner deletes (escrow), C restores.
    await deleteAccount({ accountId: owner, operationId: randomUUID() });
    caps.push(await capAfter());
    expect((await claimRequest(claimerC, jws)).status).toBe(200);
    caps.push(await capAfter());

    // The custody cap is monotonically non-increasing and bounded by the
    // allotment.
    for (let i = 1; i < caps.length; i += 1) {
      expect(caps[i] <= caps[i - 1]).toBe(true);
    }
    expect(caps[0]).toBe(PERIOD_CREDITS);

    // Cumulative movement bounded by one allotment: all remaining balances
    // plus what B burned equal exactly the single funded period.
    const balances = await Promise.all([
      getBalance(claimerB),
      getBalance(claimerC),
    ]);
    expect(balances[0]).toBe(0n);
    expect(balances[1]).toBe(PERIOD_CREDITS - 1000n);
    // The funding registry never grew past the one funded period (the
    // original sub_grant ledger row died with the owner's wallet; the
    // registry row is the durable funded-once record).
    expect(await prisma.lineagePeriodGrant.count()).toBe(1);
    // Restoration was an escrow release, never a second grant.
    expect(
      await prisma.creditLedger.count({
        where: { idempotencyKey: { startsWith: "sub_escrow_release_" } },
      }),
    ).toBe(1);
  });
});

describe("mint versus delete", () => {
  const addressFor = () =>
    `0x${randomUUID().replaceAll("-", "").padEnd(40, "b").slice(0, 40)}`;

  test("the upsert re-checks the barrier inside its transaction", async () => {
    const address = addressFor();
    const account = await prisma.account.create({
      data: { authMethods: { create: { type: "SIWE", externalKey: address } } },
    });
    await deleteAccount({ accountId: account.id, operationId: randomUUID() });

    await expect(
      upsertAuthMethodAndAccount({ type: "SIWE", externalKey: address }),
    ).rejects.toBeInstanceOf(IdentityBarredError);
    expect(
      await prisma.authMethod.count({ where: { externalKey: address } }),
    ).toBe(0);
    expect(
      await prisma.account.count({
        where: { id: { not: "48a05ef4-4a71-57a0-957f-a3d410992b31" } },
      }),
    ).toBe(0);
  });

  test("a mint racing a delete can never re-create the account behind the barrier", async () => {
    for (let round = 0; round < 4; round += 1) {
      const address = addressFor();
      const account = await prisma.account.create({
        data: {
          authMethods: { create: { type: "SIWE", externalKey: address } },
        },
      });

      const [deleted, minted] = await Promise.allSettled([
        deleteAccount({ accountId: account.id, operationId: randomUUID() }),
        upsertAuthMethodAndAccount({ type: "SIWE", externalKey: address }),
      ]);
      expect(deleted.status).toBe("fulfilled");
      if (minted.status === "fulfilled") {
        // The mint won the serialization point: it can only have adopted the
        // EXISTING account (which the delete then tore down) — never minted
        // a fresh one.
        expect(minted.value.accountId).toBe(account.id);
        expect(minted.value.created).toBe(false);
      } else {
        expect(minted.reason).toBeInstanceOf(IdentityBarredError);
      }
      // Post-state invariant, whatever the interleaving: the barrier stands
      // and no live identity/account survives behind it.
      expect(
        await prisma.authMethod.count({ where: { externalKey: address } }),
      ).toBe(0);
      expect(await prisma.account.count({ where: { id: account.id } })).toBe(0);
    }
  });
});

describe("google chain fail-closed resolution", () => {
  test("a chain loop quarantines instead of adopting a truncated root", async () => {
    await expect(
      resolveOrCreateGoogleLineage({
        token: "LOOP-A",
        linkedPurchaseToken: "LOOP-B",
        fetchChain: true,
        fetcher: (token) =>
          Promise.resolve(
            token === "LOOP-B"
              ? { linkedPurchaseToken: "LOOP-A" }
              : { linkedPurchaseToken: null },
          ),
      }),
    ).rejects.toBeInstanceOf(LineageUnresolvedError);
    const parked = await prisma.lineageQuarantine.findFirst({
      where: { token: "LOOP-A" },
    });
    expect(parked?.reason).toBe("chain_loop");
    expect(await prisma.subscriptionLineage.count()).toBe(0);
  });

  test("depth overflow quarantines instead of adopting a truncated root", async () => {
    await expect(
      resolveOrCreateGoogleLineage({
        token: "DEEP-0",
        linkedPurchaseToken: "DEEP-1",
        fetchChain: true,
        fetcher: (token) => {
          const n = Number.parseInt(token.split("-")[1] ?? "0", 10);
          return Promise.resolve({ linkedPurchaseToken: `DEEP-${n + 1}` });
        },
      }),
    ).rejects.toBeInstanceOf(LineageUnresolvedError);
    const parked = await prisma.lineageQuarantine.findFirst({
      where: { token: "DEEP-0" },
    });
    expect(parked?.reason).toBe("chain_depth_exceeded");
    expect(await prisma.subscriptionLineage.count()).toBe(0);
  });

  test("concurrent first resolution of overlapping chains creates one lineage", async () => {
    const fetcher = (token: string) =>
      Promise.resolve(
        token === "RACE-3"
          ? { linkedPurchaseToken: "RACE-2" }
          : token === "RACE-2"
            ? { linkedPurchaseToken: "RACE-1" }
            : { linkedPurchaseToken: null },
      );
    const results = await Promise.all([
      resolveOrCreateGoogleLineage({
        token: "RACE-3",
        linkedPurchaseToken: "RACE-2",
        fetchChain: true,
        fetcher,
      }),
      resolveOrCreateGoogleLineage({
        token: "RACE-2",
        linkedPurchaseToken: "RACE-1",
        fetchChain: true,
        fetcher,
      }),
    ]);
    expect(results[0]).toBe(results[1]);
    expect(await prisma.subscriptionLineage.count()).toBe(1);
    const aliases = await prisma.lineageTokenAlias.findMany({
      where: { lineageId: results[0] },
    });
    expect(aliases.map((a) => a.token).sort()).toEqual([
      "RACE-1",
      "RACE-2",
      "RACE-3",
    ]);
  });
});
