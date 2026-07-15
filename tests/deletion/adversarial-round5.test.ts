import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import { BillingProvider } from "@prisma/client";
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
import { __setAuthActivityStampFailureForTests } from "@/accounts/auth-activity";
import { deleteAccount } from "@/accounts/deletion/service";
import {
  __setClaimAppCheckVerifierForTests,
  __setPendingTransferNotifierForTests,
  claimAppCheckMiddleware,
  subscriptionClaimHandler,
} from "@/api/v2/accounts/handlers/subscription-claim";
import { googlePlayWebhookRouter } from "@/api/v2/subscriptions/google-play-webhook.router";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { getBalance } from "@/payments";
import {
  resetAppleApiClientForTests,
  setAppleApiClientForTests,
} from "@/subscriptions/apple-server-api";
import { settlePendingTransfers } from "@/subscriptions/claim";
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
import { runReclaimReconciliationSweep } from "@/subscriptions/reconciliation";
import {
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionPeriod,
  SubscriptionStatus,
  upsertFromVerify,
  type AppleVerifyInput,
  type GooglePlayVerifyInput,
} from "@/subscriptions/repository";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import { setRuntimeConfig } from "@/utils/runtimeConfig";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const TEST_BUNDLE_ID = "app.convos.test";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PERIOD_START = new Date(Date.now() - 5 * DAY_MS);
const PERIOD_END = new Date(Date.now() + 25 * DAY_MS);
const NEXT_PERIOD_END = new Date(PERIOD_END.getTime() + 30 * DAY_MS);
const PERIOD_CREDITS = 2500n;
const PRODUCT_ID = "app.convos.subs.monthly";
const OTX = "6000000000000001";
const DRIFT_WATERMARK_KEY = "subscription_reclaim_drift_watermark";

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

const probeApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.get("/probe", authMiddleware, (_req, res) => {
    res.json({ ok: true });
  });
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

const newAccount = async (lastAuthAt?: Date | null) => {
  const account = await prisma.account.create({
    data: {
      lastAuthAt:
        lastAuthAt === undefined ? new Date(Date.now() - HOUR_MS) : lastAuthAt,
    },
  });
  return account.id;
};

const tokenFor = (accountId: string) =>
  createJwtToken({ deviceId: `dev-${accountId.slice(0, 8)}`, accountId });

const signTransaction = async (overrides: Record<string, unknown> = {}) => {
  const payload = {
    transactionId: OTX,
    originalTransactionId: OTX,
    bundleId: TEST_BUNDLE_ID,
    productId: PRODUCT_ID,
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

const appleStatuses = (args: { status: number; signedLatest: string }) => ({
  data: [
    {
      lastTransactions: [
        {
          originalTransactionId: OTX,
          status: args.status,
          signedTransactionInfo: args.signedLatest,
        },
      ],
    },
  ],
});

const installAppleStatuses = (args: {
  status: number;
  signedLatest: string;
}) => {
  setAppleApiClientForTests({
    getAllSubscriptionStatuses: () => Promise.resolve(appleStatuses(args)),
  } as never);
};

const appleInput = (
  accountId: string,
  overrides: Partial<AppleVerifyInput> = {},
): AppleVerifyInput => ({
  provider: BillingProvider.apple,
  accountId,
  appAccountToken: "11111111-2222-3333-4444-555555555555",
  productId: PRODUCT_ID,
  tier: SUBSCRIPTION_TIER_PLUS,
  period: SubscriptionPeriod.monthly,
  status: SubscriptionStatus.active,
  originalTransactionId: OTX,
  transactionId: OTX,
  startedAt: PERIOD_START,
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  willRenew: true,
  isInTrial: false,
  environment: "sandbox",
  signedPayload: "jws-test-payload",
  ...overrides,
});

const playInput = (
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

/** Play purchase fixture; latestOrderId omitted when null. */
const playPurchase = (args: {
  latestOrderId: string | null;
  expiry?: Date;
  state?: string;
}): SubscriptionPurchaseV2 => ({
  subscriptionState: args.state ?? PlaySubscriptionState.active,
  startTime: PERIOD_START.toISOString(),
  ...(args.latestOrderId === null ? {} : { latestOrderId: args.latestOrderId }),
  lineItems: [
    {
      productId: PRODUCT_ID,
      expiryTime: (args.expiry ?? PERIOD_END).toISOString(),
      autoRenewingPlan: { autoRenewEnabled: true },
    },
  ],
  externalAccountIdentifiers: { obfuscatedExternalAccountId: "obf-r5" },
});

const wipe = async () => {
  __setAuthActivityStampFailureForTests(null);
  __setClaimAppCheckVerifierForTests(null);
  __setPendingTransferNotifierForTests(null);
  resetVerifierForTests();
  resetAppleApiClientForTests();
  resetPlayApiClientForTests();
  setPlayApiFixtureForTests(null);
  setPubsubVerifierForTests(null);
  delete process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED;
  delete process.env.SUBSCRIPTION_CLAIM_GOOGLE_ENABLED;
  delete process.env.CLAIM_CONTEST_WINDOW_HOURS;
  await setRuntimeConfig("app_attest_enabled", "true");
  await prisma.runtimeConfig.deleteMany({
    where: { key: DRIFT_WATERMARK_KEY },
  });
  await prisma.rateLimitCounter.deleteMany();
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

const appleClaimRequest = async (accountId: string, jws: string) =>
  request(claimApp())
    .post("/v2/accounts/me/subscription/claim")
    .set("X-Convos-AuthToken", await tokenFor(accountId))
    .set("X-Firebase-AppCheck", `limited-${randomUUID()}`)
    .send({ platform: "apple", jwsRepresentation: jws });

/** Live 72h Apple claim: owner + claimer + one pending transfer row. */
const createPendingTransfer = async () => {
  process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
  process.env.CLAIM_CONTEST_WINDOW_HOURS = "72";
  installLocalTestingVerifier();
  __setClaimAppCheckVerifierForTests(() => Promise.resolve());
  __setPendingTransferNotifierForTests(() => Promise.resolve());
  const owner = await newAccount();
  const claimer = await newAccount();
  await upsertFromVerify(appleInput(owner));
  const jws = await signTransaction();
  installAppleStatuses({ status: 1, signedLatest: jws });
  const res = await appleClaimRequest(claimer, jws);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const pendingRow = await prisma.subscriptionTransfer.findFirstOrThrow({
    where: { status: "pending" },
  });
  return { owner, claimer, jws, pendingRow };
};

/** Instant Apple transfer (contest window 0): one committed journal. */
const createCommittedTransfer = async () => {
  process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
  process.env.CLAIM_CONTEST_WINDOW_HOURS = "0";
  installLocalTestingVerifier();
  __setClaimAppCheckVerifierForTests(() => Promise.resolve());
  const owner = await newAccount();
  const claimer = await newAccount();
  await upsertFromVerify(appleInput(owner));
  const jws = await signTransaction();
  installAppleStatuses({ status: 1, signedLatest: jws });
  const res = await appleClaimRequest(claimer, jws);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { owner, claimer, jws };
};

describe("activity stamp fails closed", () => {
  test("a stamp DB failure during a contest window fails the request; the retry still vetoes", async () => {
    const { owner, pendingRow } = await createPendingTransfer();
    // The owner authenticated an hour ago (outside the throttle window), so
    // the probe below must attempt the stamp write - which we make fail.
    const before = await prisma.account.findUniqueOrThrow({
      where: { id: owner },
    });
    __setAuthActivityStampFailureForTests(new Error("transient stamp failure"));

    const failed = await request(probeApp())
      .get("/probe")
      .set("X-Convos-AuthToken", await tokenFor(owner));
    // Fail closed: the act must not succeed unstamped - a swallowed error
    // here would let settlement read the stale timestamp and execute the
    // transfer despite real owner activity.
    expect(failed.status).toBe(500);
    const unchanged = await prisma.account.findUniqueOrThrow({
      where: { id: owner },
    });
    expect(unchanged.lastAuthAt?.getTime()).toBe(before.lastAuthAt?.getTime());
    __setAuthActivityStampFailureForTests(null);

    // The owner's retry (the DB recovered) stamps and preserves the veto.
    const retried = await request(probeApp())
      .get("/probe")
      .set("X-Convos-AuthToken", await tokenFor(owner));
    expect(retried.status).toBe(200);
    const stamped = await prisma.account.findUniqueOrThrow({
      where: { id: owner },
    });
    expect(stamped.lastAuthAt?.getTime() ?? 0).toBeGreaterThan(
      pendingRow.createdAt.getTime(),
    );

    await prisma.subscriptionTransfer.updateMany({
      where: { status: "pending" },
      data: { contestEndsAt: new Date(Date.now() - 1000) },
    });
    const settled = await settlePendingTransfers();
    expect(settled.cancelled).toBe(1);
    expect(settled.committed).toBe(0);
    const row = await prisma.subscription.findFirstOrThrow({
      where: { originalTransactionId: OTX },
    });
    expect(row.accountId).toBe(owner);
  });
});

describe("drift reconciliation sweeps 72h-contested settlements", () => {
  test("a default contest-window transfer settles, then drifts, and IS swept", async () => {
    const { owner, claimer, pendingRow } = await createPendingTransfer();
    // Age the pending row to the real 72h shape: created 73 hours ago,
    // window just ended, owner silent since before the claim (ghost).
    const createdAt = new Date(Date.now() - 73 * HOUR_MS);
    await prisma.subscriptionTransfer.update({
      where: { id: pendingRow.id },
      data: { createdAt, contestEndsAt: new Date(Date.now() - 1000) },
    });
    await prisma.account.update({
      where: { id: owner },
      data: { lastAuthAt: new Date(Date.now() - 80 * HOUR_MS) },
    });
    const settled = await settlePendingTransfers();
    expect(settled.committed).toBe(1);
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);

    const journal = await prisma.subscriptionTransfer.findUniqueOrThrow({
      where: { id: pendingRow.id },
    });
    expect(journal.status).toBe("committed");
    expect(journal.committedAt).not.toBeNull();
    // The exact shape the old createdAt-window selection missed: by
    // settlement time the journal's createdAt is 73 hours old.
    expect(journal.createdAt.getTime()).toBeLessThan(Date.now() - 72 * HOUR_MS);

    // The provider revokes after settlement; the webhook is lost.
    installAppleStatuses({ status: 2, signedLatest: "irrelevant" });
    const counts = await runReclaimReconciliationSweep();
    expect(counts.driftChecked).toBe(1);
    expect(counts.driftCompensated).toBe(1);
    expect(await getBalance(claimer)).toBe(0n);
    const custody = await prisma.lineagePeriodCustody.findFirstOrThrow({});
    expect(custody.state).toBe("invalidated");
    // The Subscription row carries the provider-derived terminal state.
    const row = await prisma.subscription.findFirstOrThrow({
      where: { originalTransactionId: OTX },
    });
    expect(row.status).toBe(SubscriptionStatus.expired);
    expect(row.willRenew).toBe(false);
  });
});

describe("quarantine retry state prevents starvation", () => {
  test("30 persistent rows cannot starve a newer recoverable row", async () => {
    const owner = await newAccount();
    const recoverableToken = "r5-recoverable";
    await upsertFromVerify(playInput(owner, recoverableToken));
    expect(await getBalance(owner)).toBe(PERIOD_CREDITS);

    // 30 persistently-keyless rows, all due before the recoverable row.
    await prisma.lineageQuarantine.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        provider: BillingProvider.googlePlay,
        token: `r5-starving-${i}`,
        reason: "missing_latest_order_id",
        payload: { source: "rtdn" },
        nextAttemptAt: new Date(Date.now() - 10_000),
      })),
    });
    await prisma.lineageQuarantine.create({
      data: {
        provider: BillingProvider.googlePlay,
        token: recoverableToken,
        reason: "missing_latest_order_id",
        payload: { source: "rtdn" },
      },
    });
    setPlayApiFixtureForTests((token) =>
      token === recoverableToken
        ? playPurchase({
            latestOrderId: `GPA.${recoverableToken}..1`,
            expiry: NEXT_PERIOD_END,
          })
        : playPurchase({ latestOrderId: null }),
    );

    // First sweep: the batch fills with 25 persistent rows; each defers
    // with backoff (the old fixed oldest-25 selection would reselect these
    // same rows forever).
    const first = await runReclaimReconciliationSweep();
    expect(first.quarantineDeferred).toBe(25);
    expect(first.quarantineRecovered).toBe(0);

    // Second sweep: the deferred rows are backed off out of the batch, so
    // the newer recoverable row is reached and resolved.
    const second = await runReclaimReconciliationSweep();
    expect(second.quarantineRecovered).toBe(1);
    const resolved = await prisma.lineageQuarantine.findFirstOrThrow({
      where: { token: recoverableToken },
    });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(await getBalance(owner)).toBe(2n * PERIOD_CREDITS);
    // The persistent rows carry their retry state instead of hogging the
    // batch: attempts counted, next attempt backed off into the future.
    const starving = await prisma.lineageQuarantine.findFirstOrThrow({
      where: { token: "r5-starving-0" },
    });
    expect(starving.attempts).toBeGreaterThanOrEqual(1);
    expect(starving.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(starving.resolvedAt).toBeNull();
  });
});

describe("drift-versus-renewal race", () => {
  test("a renewal landing between the provider fetch and the lock survives (version fence)", async () => {
    const { claimer } = await createCommittedTransfer();
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);
    const renewalTxn = "6000000000000042";

    // The provider mock interleaves the exact TOCTOU: while the sweep is
    // fetching entitlement, a renewal webhook advances the subscription and
    // funds the new period; the fetch then answers with the STALE
    // "not entitled" for the old period.
    let renewed = false;
    setAppleApiClientForTests({
      getAllSubscriptionStatuses: async () => {
        if (!renewed) {
          renewed = true;
          await upsertFromVerify(
            appleInput(claimer, {
              transactionId: renewalTxn,
              currentPeriodStart: PERIOD_END,
              currentPeriodEnd: NEXT_PERIOD_END,
            }),
          );
          return appleStatuses({ status: 2, signedLatest: "stale" });
        }
        return appleStatuses({ status: 1, signedLatest: "fresh" });
      },
    } as never);

    const first = await runReclaimReconciliationSweep();
    expect(renewed).toBe(true);
    // The fence tripped: nothing was clawed with the stale answer.
    expect(first.driftDeferred).toBe(1);
    expect(first.driftCompensated).toBe(0);
    expect(await getBalance(claimer)).toBe(2n * PERIOD_CREDITS);
    const renewedCustody = await prisma.lineagePeriodCustody.findFirstOrThrow({
      where: { providerPeriodKey: `apple_txn_${renewalTxn}` },
    });
    expect(renewedCustody.state).toBe("held");

    // The deferred journal held the watermark: the next sweep re-checks
    // with fresh provider state (now entitled) and settles without clawing.
    const second = await runReclaimReconciliationSweep();
    expect(second.driftChecked).toBe(1);
    expect(second.driftCompensated).toBe(0);
    expect(await getBalance(claimer)).toBe(2n * PERIOD_CREDITS);
    const row = await prisma.subscription.findFirstOrThrow({
      where: { originalTransactionId: OTX },
    });
    expect(row.status).toBe(SubscriptionStatus.active);
  });
});

describe("keyless void reconciliation end-to-end", () => {
  const postKeylessVoid = async (token: string) => {
    setPubsubVerifierForTests(() => undefined);
    const res = await request(rtdnApp())
      .post("/v2/webhooks/google-play/rtdn")
      .send({
        message: {
          messageId: `msg-${randomUUID()}`,
          data: Buffer.from(
            JSON.stringify({
              voidedPurchaseNotification: { purchaseToken: token },
            }),
          ).toString("base64"),
        },
      });
    expect(res.status).toBe(200);
    const parked = await prisma.lineageQuarantine.findFirstOrThrow({
      where: { token, reason: "voided_purchase_keyless" },
    });
    return parked;
  };

  test("void of the current order: terminal state applied, exact period clawed, row resolved", async () => {
    const owner = await newAccount();
    const token = "r5-void-current";
    await upsertFromVerify(playInput(owner, token));
    await postKeylessVoid(token);

    // Fresh provider state: the subscription is voided (expired, order
    // identity present) - the sweep applies terminal state and compensates
    // through the hardened notification path.
    setPlayApiFixtureForTests(() =>
      playPurchase({
        latestOrderId: `GPA.${token}..0`,
        state: PlaySubscriptionState.expired,
        expiry: new Date(Date.now() - 60_000),
      }),
    );
    const counts = await runReclaimReconciliationSweep();
    expect(counts.quarantineRecovered).toBe(1);
    expect(await getBalance(owner)).toBe(0n);
    const custody = await prisma.lineagePeriodCustody.findFirstOrThrow({
      where: { providerPeriodKey: `play_order_GPA.${token}..0` },
    });
    expect(custody.state).toBe("invalidated");
    const row = await prisma.subscription.findFirstOrThrow({
      where: { purchaseToken: token },
    });
    expect(row.status).toBe(SubscriptionStatus.expired);
    const resolved = await prisma.lineageQuarantine.findFirstOrThrow({
      where: { token },
    });
    expect(resolved.resolvedAt).not.toBeNull();
  });

  test("void of an unidentifiable historical order: escalated, never mislabeled recovered", async () => {
    const owner = await newAccount();
    const token = "r5-void-historic";
    await upsertFromVerify(playInput(owner, token));
    await postKeylessVoid(token);

    // Fresh provider state is still entitled: the void hit some historical
    // order that current state cannot identify. The old sweep applied the
    // active state and marked the row recovered - silently dropping the
    // void. It must escalate to an operator instead.
    setPlayApiFixtureForTests(() =>
      playPurchase({ latestOrderId: `GPA.${token}..3` }),
    );
    const counts = await runReclaimReconciliationSweep();
    expect(counts.quarantineRecovered).toBe(0);
    expect(counts.quarantineNeedsOperator).toBe(1);
    const parked = await prisma.lineageQuarantine.findFirstOrThrow({
      where: { token },
    });
    expect(parked.resolvedAt).toBeNull();
    expect(parked.needsOperatorAt).not.toBeNull();
    // Entitlement untouched.
    expect(await getBalance(owner)).toBe(PERIOD_CREDITS);
    const row = await prisma.subscription.findFirstOrThrow({
      where: { purchaseToken: token },
    });
    expect(row.status).toBe(SubscriptionStatus.active);
    // Escalated rows leave the retry batch: a later sweep only surfaces
    // them in the operator count, never re-drives them.
    const second = await runReclaimReconciliationSweep();
    expect(second.quarantineDeferred).toBe(0);
    expect(second.quarantineNeedsOperator).toBe(1);
  });
});

describe("sweep lease exclusivity", () => {
  test("two concurrent runners: exactly one executes", async () => {
    const { claimer } = await createCommittedTransfer();
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);

    // Gate the provider call so runner A verifiably holds the lease while
    // runner B attempts it.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let providerCalls = 0;
    setAppleApiClientForTests({
      getAllSubscriptionStatuses: async () => {
        providerCalls += 1;
        await gate;
        return appleStatuses({ status: 1, signedLatest: "fresh" });
      },
    } as never);

    const runnerA = runReclaimReconciliationSweep();
    await vi.waitFor(() => {
      expect(providerCalls).toBeGreaterThan(0);
    });
    const runnerB = await runReclaimReconciliationSweep();
    expect(runnerB.leaseAcquired).toBe(false);
    expect(runnerB.driftChecked).toBe(0);
    release();
    const resultA = await runnerA;
    expect(resultA.leaseAcquired).toBe(true);
    expect(resultA.driftChecked).toBe(1);
    // Exactly one runner made provider calls.
    expect(providerCalls).toBe(1);
  });
});

describe("expired-custody compensation", () => {
  test("a lost terminal event just after period end still claws the unspent remainder", async () => {
    const { claimer } = await createCommittedTransfer();
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);

    // The transferred period expired a minute before this sweep and the
    // terminal webhook was lost: no custody covers "now" any more.
    const custody = await prisma.lineagePeriodCustody.findFirstOrThrow({});
    await prisma.lineagePeriodCustody.update({
      where: { id: custody.id },
      data: { periodEnd: new Date(Date.now() - 60_000) },
    });
    installAppleStatuses({ status: 2, signedLatest: "irrelevant" });

    const counts = await runReclaimReconciliationSweep();
    expect(counts.driftChecked).toBe(1);
    // A covering-now lookup alone would have found nothing and left the
    // unspent value with the holder forever.
    expect(counts.driftCompensated).toBe(1);
    expect(await getBalance(claimer)).toBe(0n);
    const settled = await prisma.lineagePeriodCustody.findUniqueOrThrow({
      where: { id: custody.id },
    });
    expect(settled.state).toBe("invalidated");
    const row = await prisma.subscription.findFirstOrThrow({
      where: { originalTransactionId: OTX },
    });
    expect(row.status).toBe(SubscriptionStatus.expired);
  });
});

describe("restoration with no matching funding event", () => {
  test("parks the lineage and rejects instead of restoring zero credits", async () => {
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    await upsertFromVerify(appleInput(owner));
    await deleteAccount({ accountId: owner, operationId: randomUUID() });

    // A renewal happened while tombstoned but its notification was lost: no
    // escrow row exists for the current funding event the claim presents.
    const renewalTxn = "6000000000000099";
    const jws = await signTransaction({
      transactionId: renewalTxn,
      purchaseDate: PERIOD_END.getTime(),
      expiresDate: NEXT_PERIOD_END.getTime(),
    });
    installAppleStatuses({ status: 1, signedLatest: jws });
    const claimer = await newAccount();
    const res = await appleClaimRequest(claimer, jws);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "subscription_claim_rejected",
      reason: "lineage_unresolved",
    });

    // Fail closed: no live lineage with zero credits was minted.
    expect(await getBalance(claimer)).toBe(0n);
    expect(await prisma.subscription.count()).toBe(0);
    const lineage = await prisma.subscriptionLineage.findFirstOrThrow({
      where: { lineageKey: OTX },
    });
    expect(lineage.state).toBe("tombstoned");
    const escrow = await prisma.lineagePeriodCustody.findFirstOrThrow({
      where: { providerPeriodKey: `apple_txn_${OTX}` },
    });
    expect(escrow.state).toBe("escrow");
    // Parked (with alert) for an operator/backfill.
    const parked = await prisma.lineageQuarantine.findMany({
      where: { reason: "restoration_missing_funding_event" },
    });
    expect(parked).toHaveLength(1);
    expect(parked[0].token).toBe(OTX);

    // A retried claim converges on the same parked row - no duplicates.
    const retry = await appleClaimRequest(claimer, jws);
    expect(retry.status).toBe(409);
    expect(
      await prisma.lineageQuarantine.count({
        where: { reason: "restoration_missing_funding_event" },
      }),
    ).toBe(1);
  });
});
