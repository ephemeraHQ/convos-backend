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
import { deleteAccount } from "@/accounts/deletion/service";
import {
  __setClaimAppCheckVerifierForTests,
  __setPendingTransferNotifierForTests,
  claimAppCheckMiddleware,
  subscriptionClaimHandler,
} from "@/api/v2/accounts/handlers/subscription-claim";
import { googlePlayWebhookRouter } from "@/api/v2/subscriptions/google-play-webhook.router";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import {
  __setClaimCeilingIncrementForTests,
  makeClaimGlobalCeiling,
} from "@/middleware/claimGlobalCeiling";
import { pinoMiddleware } from "@/middleware/pino";
import { getBalance } from "@/payments";
import {
  resetAppleApiClientForTests,
  setAppleApiClientForTests,
} from "@/subscriptions/apple-server-api";
import { settlePendingTransfers } from "@/subscriptions/claim";
import { evaluateClaimable } from "@/subscriptions/claim-eligibility";
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
  applyNotification,
  compensateVoidedPurchase,
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionPeriod,
  SubscriptionStatus,
  upsertFromVerify,
  type AppleVerifyInput,
  type GooglePlayApplyNotificationInput,
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
const PERIOD_START = new Date(Date.now() - 5 * DAY_MS);
const PERIOD_END = new Date(Date.now() + 25 * DAY_MS);
const NEXT_PERIOD_END = new Date(PERIOD_END.getTime() + 30 * DAY_MS);
const PERIOD_CREDITS = 2500n;
const PRODUCT_ID = "app.convos.subs.monthly";

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
        lastAuthAt === undefined
          ? new Date(Date.now() - 60 * 60 * 1000)
          : lastAuthAt,
    },
  });
  return account.id;
};

const tokenFor = (accountId: string) =>
  createJwtToken({ deviceId: `dev-${accountId.slice(0, 8)}`, accountId });

const signTransaction = async (overrides: Record<string, unknown> = {}) => {
  const payload = {
    transactionId: "6000000000000001",
    originalTransactionId: "6000000000000001",
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

const installAppleStatuses = (args: {
  otx: string;
  status: number;
  signedLatest: string;
}) => {
  setAppleApiClientForTests({
    getAllSubscriptionStatuses: () =>
      Promise.resolve({
        data: [
          {
            lastTransactions: [
              {
                originalTransactionId: args.otx,
                status: args.status,
                signedTransactionInfo: args.signedLatest,
              },
            ],
          },
        ],
      }),
  } as never);
};

const appleInput = (accountId: string, otx: string): AppleVerifyInput => ({
  provider: BillingProvider.apple,
  accountId,
  appAccountToken: "11111111-2222-3333-4444-555555555555",
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
  externalAccountIdentifiers: { obfuscatedExternalAccountId: "obf-r4" },
});

const wipe = async () => {
  __setClaimAppCheckVerifierForTests(null);
  __setPendingTransferNotifierForTests(null);
  __setClaimCeilingIncrementForTests(null);
  resetVerifierForTests();
  resetAppleApiClientForTests();
  resetPlayApiClientForTests();
  setPlayApiFixtureForTests(null);
  setPubsubVerifierForTests(null);
  delete process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED;
  delete process.env.SUBSCRIPTION_CLAIM_GOOGLE_ENABLED;
  delete process.env.CLAIM_CONTEST_WINDOW_HOURS;
  await setRuntimeConfig("app_attest_enabled", "true");
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

type ClaimBody = { code?: string; reason?: string };

const appleClaimRequest = async (accountId: string, jws: string) =>
  request(claimApp())
    .post("/v2/accounts/me/subscription/claim")
    .set("X-Convos-AuthToken", await tokenFor(accountId))
    .set("X-Firebase-AppCheck", `limited-${randomUUID()}`)
    .send({ platform: "apple", jwsRepresentation: jws });

const playClaimRequest = async (accountId: string, purchaseToken: string) =>
  request(claimApp())
    .post("/v2/accounts/me/subscription/claim")
    .set("X-Convos-AuthToken", await tokenFor(accountId))
    .set("X-Firebase-AppCheck", `limited-${randomUUID()}`)
    .send({ platform: "googlePlay", purchaseToken, productId: PRODUCT_ID });

/** Google renewal notification with the lifetime startTime (never advances). */
const playRenewal = (
  token: string,
  orderId: string,
  periodEnd: Date,
): GooglePlayApplyNotificationInput => ({
  provider: BillingProvider.googlePlay,
  purchaseToken: token,
  linkedPurchaseToken: null,
  playOrderId: orderId,
  messageId: `msg-${randomUUID()}`,
  notificationType: "PLAY_2",
  notificationSubtype: null,
  signedPayload: "{}",
  update: {
    status: SubscriptionStatus.active,
    tier: SUBSCRIPTION_TIER_PLUS,
    productId: PRODUCT_ID,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: periodEnd,
    willRenew: true,
  },
});

describe("google restoration releases the exact funding event's escrow", () => {
  test("claim during P2 releases P2's escrow, never P1's (lifetime startTime)", async () => {
    process.env.SUBSCRIPTION_CLAIM_GOOGLE_ENABLED = "true";
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const token = "restore-token-1";
    const orderP1 = `GPA.${token}..0`;
    const orderP2 = `GPA.${token}..1`;
    await upsertFromVerify(playInput(owner, token, { playOrderId: orderP1 }));
    await deleteAccount({ accountId: owner, operationId: randomUUID() });

    // Renewal while tombstoned funds P2's escrow.
    const renewal = await applyNotification(
      playRenewal(token, orderP2, NEXT_PERIOD_END),
    );
    expect(renewal.kind).toBe("tombstoned");

    // The claim presents the current purchase: latestOrderId = P2's order,
    // reported period start = lifetime startTime (P1 still "covers" it —
    // the old window-covering selection would release P1's escrow).
    setPlayApiFixtureForTests(() =>
      playPurchase({ latestOrderId: orderP2, expiry: NEXT_PERIOD_END }),
    );
    const claimer = await newAccount();
    const res = await playClaimRequest(claimer, token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Exactly P2's allotment was released.
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);
    const p1 = await prisma.lineagePeriodCustody.findFirstOrThrow({
      where: { providerPeriodKey: `play_order_${orderP1}` },
    });
    const p2 = await prisma.lineagePeriodCustody.findFirstOrThrow({
      where: { providerPeriodKey: `play_order_${orderP2}` },
    });
    expect(p2.state).toBe("held");
    expect(p2.ownerAccountId).toBe(claimer);
    // P1's escrow was NOT released to the claimant (still ownerless).
    expect(p1.ownerAccountId).toBeNull();
    expect(["escrow", "exhausted"]).toContain(p1.state);
  });
});

describe("keyless google claim fails closed", () => {
  test("no latestOrderId -> 409 lineage_unresolved, parked in quarantine", async () => {
    process.env.SUBSCRIPTION_CLAIM_GOOGLE_ENABLED = "true";
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const token = "keyless-claim-1";
    await upsertFromVerify(playInput(owner, token));
    await deleteAccount({ accountId: owner, operationId: randomUUID() });

    setPlayApiFixtureForTests(() => playPurchase({ latestOrderId: null }));
    const claimer = await newAccount();
    const res = await playClaimRequest(claimer, token);
    expect(res.status).toBe(409);
    expect((res.body as ClaimBody).reason).toBe("lineage_unresolved");
    const parked = await prisma.lineageQuarantine.findFirst({
      where: { token, reason: "missing_latest_order_id" },
    });
    expect(parked).not.toBeNull();
    expect(await getBalance(claimer)).toBe(0n);
    // The tombstoned lineage was not restored.
    const lineage = await prisma.subscriptionLineage.findFirstOrThrow({
      where: { provider: BillingProvider.googlePlay },
    });
    expect(lineage.state).toBe("tombstoned");
  });
});

describe("google provider claim gate (Apple-only product)", () => {
  test("google claims are rejected while the provider flag is off (default)", async () => {
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const token = "gated-token-1";
    await upsertFromVerify(playInput(owner, token));
    await deleteAccount({ accountId: owner, operationId: randomUUID() });

    // No Play fixture installed: the gate must reject before any provider
    // call (a fetch attempt would 404 the fixture and 400 the claim).
    const claimer = await newAccount();
    const res = await playClaimRequest(claimer, token);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "subscription_claim_rejected",
      reason: "transfer_frozen",
    });
    const lineage = await prisma.subscriptionLineage.findFirstOrThrow({
      where: { provider: BillingProvider.googlePlay },
    });
    expect(lineage.state).toBe("tombstoned");

    // Verify's claimable signal is false for Google lineages while gated...
    expect(
      await evaluateClaimable({
        provider: BillingProvider.googlePlay,
        keys: [token],
      }),
    ).toBe(false);
    // ...and true again once the provider flag flips.
    process.env.SUBSCRIPTION_CLAIM_GOOGLE_ENABLED = "true";
    expect(
      await evaluateClaimable({
        provider: BillingProvider.googlePlay,
        keys: [token],
      }),
    ).toBe(true);
  });

  test("apple claims are unaffected by the google gate", async () => {
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const otx = "6000000000000001";
    const owner = await newAccount();
    await upsertFromVerify(appleInput(owner, otx));
    await deleteAccount({ accountId: owner, operationId: randomUUID() });
    const jws = await signTransaction();
    installAppleStatuses({ otx, status: 1, signedLatest: jws });
    const claimer = await newAccount();
    const res = await appleClaimRequest(claimer, jws);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);
  });
});

describe("tombstoned rotation with a conflicting alias", () => {
  test("the event quarantines and never funds the tombstoned lineage", async () => {
    // L1: tombstoned lineage rooted at Told (real deletion).
    const owner = await newAccount();
    const tOld = "conflict-told";
    const tNew = "conflict-tnew";
    await upsertFromVerify(playInput(owner, tOld));
    await deleteAccount({ accountId: owner, operationId: randomUUID() });
    const l1 = await prisma.subscriptionLineage.findFirstOrThrow({
      where: { lineageKey: tOld },
    });
    // L2: a different lineage already owns the presented token as an alias.
    const l2 = await prisma.subscriptionLineage.create({
      data: { provider: BillingProvider.googlePlay, lineageKey: "troot-2" },
    });
    await prisma.lineageTokenAlias.create({
      data: { token: tNew, lineageId: l2.id },
    });

    const grantsBefore = await prisma.lineagePeriodGrant.count();
    const custodyBefore = await prisma.lineagePeriodCustody.count();
    const result = await applyNotification({
      ...playRenewal(tOld, "GPA.conflict..1", NEXT_PERIOD_END),
      purchaseToken: tNew,
      linkedPurchaseToken: tOld,
    });
    // Acked as a counted no-op; the conflict is quarantined for the sweep.
    expect(result.kind).toBe("tombstoned");
    const parked = await prisma.lineageQuarantine.findFirst({
      where: { token: tNew },
    });
    expect(parked?.reason).toBe("alias_conflict_between_lineages");
    // No funding effect landed on the tombstoned lineage.
    expect(await prisma.lineagePeriodGrant.count()).toBe(grantsBefore);
    expect(await prisma.lineagePeriodCustody.count()).toBe(custodyBefore);
    // The existing alias was not silently repointed.
    const alias = await prisma.lineageTokenAlias.findUniqueOrThrow({
      where: { token: tNew },
    });
    expect(alias.lineageId).toBe(l2.id);
    expect(l1.state).toBe("tombstoned");
  });
});

describe("activity veto via a real authenticated request", () => {
  const probeApp = () => {
    const app = express();
    app.use(pinoMiddleware);
    app.use(json());
    app.get("/probe", authMiddleware, (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  };

  test("an authenticated act inside the stamp-throttle window still vetoes a pending transfer", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "72";
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    __setPendingTransferNotifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const claimer = await newAccount();
    const otx = "6000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    const jws = await signTransaction();
    installAppleStatuses({ otx, status: 1, signedLatest: jws });
    expect((await appleClaimRequest(claimer, jws)).status).toBe(202);

    // Codex's bypass shape: the owner authenticated moments BEFORE the
    // pending row (lastAuthAt recent, inside the 5-minute throttle window),
    // then performs a real authenticated act AFTER it. The old
    // fire-and-forget throttled stamp suppressed the write and settlement
    // executed the theft.
    const pendingRow = await prisma.subscriptionTransfer.findFirstOrThrow({
      where: { status: "pending" },
    });
    await prisma.account.update({
      where: { id: owner },
      data: { lastAuthAt: new Date(pendingRow.createdAt.getTime() - 30_000) },
    });

    const probe = await request(probeApp())
      .get("/probe")
      .set("X-Convos-AuthToken", await tokenFor(owner));
    expect(probe.status).toBe(200);

    // The stamp landed (awaited, DB clock) despite the throttle window.
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
      where: { originalTransactionId: otx },
    });
    expect(row.accountId).toBe(owner);
  });

  test("without a pending transfer the stamp stays throttled", async () => {
    const accountId = await newAccount(new Date(Date.now() - 30_000));
    const before = await prisma.account.findUniqueOrThrow({
      where: { id: accountId },
    });
    const probe = await request(probeApp())
      .get("/probe")
      .set("X-Convos-AuthToken", await tokenFor(accountId));
    expect(probe.status).toBe(200);
    const after = await prisma.account.findUniqueOrThrow({
      where: { id: accountId },
    });
    expect(after.lastAuthAt?.getTime()).toBe(before.lastAuthAt?.getTime());
  });
});

describe("voided purchases fail closed on unmatched orders", () => {
  test("keyless void: parked, nothing revoked", async () => {
    const owner = await newAccount();
    const token = "void-keyless-1";
    await upsertFromVerify(playInput(owner, token));
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
    const parked = await prisma.lineageQuarantine.findFirst({
      where: { token, reason: "voided_purchase_keyless" },
    });
    expect(parked).not.toBeNull();
    // Current entitlement untouched: no revoke, custody intact.
    const row = await prisma.subscription.findFirstOrThrow({
      where: { purchaseToken: token },
    });
    expect(row.status).toBe(SubscriptionStatus.active);
    const custody = await prisma.lineagePeriodCustody.findFirstOrThrow({});
    expect(custody.state).toBe("held");
    expect(await getBalance(owner)).toBe(PERIOD_CREDITS);
  });

  test("unmatched old order: parked, current period never clawed", async () => {
    const owner = await newAccount();
    const token = "void-unmatched-1";
    await upsertFromVerify(playInput(owner, token));
    const result = await compensateVoidedPurchase(token, "GPA.never-seen..7");
    expect(result).toEqual({ kind: "parked" });
    const parked = await prisma.lineageQuarantine.findFirst({
      where: { token, reason: "voided_purchase_unmatched_order" },
    });
    expect(parked).not.toBeNull();
    const row = await prisma.subscription.findFirstOrThrow({
      where: { purchaseToken: token },
    });
    expect(row.status).toBe(SubscriptionStatus.active);
    expect(await getBalance(owner)).toBe(PERIOD_CREDITS);
  });

  test("matched order still compensates exactly that period", async () => {
    const owner = await newAccount();
    const token = "void-matched-1";
    await upsertFromVerify(playInput(owner, token));
    const result = await compensateVoidedPurchase(token, `GPA.${token}..0`);
    expect(result.kind).toBe("compensated");
    expect(await getBalance(owner)).toBe(0n);
    const row = await prisma.subscription.findFirstOrThrow({
      where: { purchaseToken: token },
    });
    expect(row.status).toBe(SubscriptionStatus.revoked);
  });
});

describe("global claim ceiling (shared counter)", () => {
  const ceilingApp = (limit: number) => {
    const app = express();
    app.use(pinoMiddleware);
    app.use(json());
    app.post(
      "/claim",
      makeClaimGlobalCeiling({ windowSeconds: 3600, limit }),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    return app;
  };

  test("fails CLOSED (503) when the counter store errors", async () => {
    __setClaimCeilingIncrementForTests(() =>
      Promise.reject(new Error("counter store down")),
    );
    const res = await request(ceilingApp(200)).post("/claim").send({});
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "Subscription claims are temporarily unavailable",
    });
  });

  test("blocks past the ceiling and counts concurrent increments exactly", async () => {
    const app = ceilingApp(5);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => request(app).post("/claim").send({})),
    );
    const ok = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 429).length;
    expect(ok).toBe(5);
    expect(limited).toBe(3);
    // The shared counter recorded every hit exactly once (atomic upsert).
    const counter = await prisma.rateLimitCounter.findFirstOrThrow({
      where: { key: "subscription_claim_global" },
    });
    expect(counter.count).toBe(8);
  });
});

describe("reconciliation sweep", () => {
  test("recovers a parked keyless renewal once the order identity appears (idempotent)", async () => {
    const owner = await newAccount();
    const token = "sweep-keyless-1";
    await upsertFromVerify(playInput(owner, token));
    expect(await getBalance(owner)).toBe(PERIOD_CREDITS);
    // The keyless renewal was parked by the online path.
    await prisma.lineageQuarantine.create({
      data: {
        provider: BillingProvider.googlePlay,
        token,
        reason: "missing_latest_order_id",
        payload: { source: "rtdn" },
      },
    });
    // The provider now reports the renewal with its order identity.
    setPlayApiFixtureForTests(() =>
      playPurchase({
        latestOrderId: `GPA.${token}..1`,
        expiry: NEXT_PERIOD_END,
      }),
    );

    const first = await runReclaimReconciliationSweep();
    expect(first.quarantineRecovered).toBe(1);
    expect(await getBalance(owner)).toBe(2n * PERIOD_CREDITS);
    const resolved = await prisma.lineageQuarantine.findFirstOrThrow({
      where: { token },
    });
    expect(resolved.resolvedAt).not.toBeNull();

    // Idempotent: a second sweep changes nothing.
    const second = await runReclaimReconciliationSweep();
    expect(second.quarantineRecovered).toBe(0);
    expect(await getBalance(owner)).toBe(2n * PERIOD_CREDITS);
    expect(await prisma.lineagePeriodGrant.count()).toBe(2);
  });

  test("post-transfer drift: a provider revocation after settlement is compensated once", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "0";
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const claimer = await newAccount();
    const otx = "6000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    const jws = await signTransaction();
    installAppleStatuses({ otx, status: 1, signedLatest: jws });
    expect((await appleClaimRequest(claimer, jws)).status).toBe(200);
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);

    // The provider revokes AFTER the transfer committed; the webhook is
    // lost. The drift pass re-checks recent transfers and compensates.
    installAppleStatuses({ otx, status: 2, signedLatest: jws });
    const first = await runReclaimReconciliationSweep();
    expect(first.driftChecked).toBe(1);
    expect(first.driftCompensated).toBe(1);
    expect(await getBalance(claimer)).toBe(0n);
    const custody = await prisma.lineagePeriodCustody.findFirstOrThrow({});
    expect(custody.state).toBe("invalidated");

    // Idempotent: nothing further to claw.
    const second = await runReclaimReconciliationSweep();
    expect(second.driftCompensated).toBe(0);
    expect(await getBalance(claimer)).toBe(0n);
  });

  test("conflict-class quarantine rows are never auto-merged", async () => {
    await prisma.lineageQuarantine.create({
      data: {
        provider: BillingProvider.googlePlay,
        token: "conflict-token",
        reason: "alias_conflict_between_lineages",
        payload: {},
      },
    });
    const counts = await runReclaimReconciliationSweep();
    expect(counts.quarantineNeedsOperator).toBe(1);
    expect(counts.quarantineRecovered).toBe(0);
    const row = await prisma.lineageQuarantine.findFirstOrThrow({
      where: { token: "conflict-token" },
    });
    expect(row.resolvedAt).toBeNull();
  });
});
