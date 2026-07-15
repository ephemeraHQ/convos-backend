import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import { BillingProvider } from "@prisma/client";
import express, { json } from "express";
import { importPKCS8, SignJWT } from "jose";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  __setClaimAppCheckVerifierForTests,
  __setPendingTransferNotifierForTests,
  claimAppCheckMiddleware,
  subscriptionClaimHandler,
} from "@/api/v2/accounts/handlers/subscription-claim";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { getBalance, grant } from "@/payments";
import {
  resetAppleApiClientForTests,
  setAppleApiClientForTests,
} from "@/subscriptions/apple-server-api";
import { settlePendingTransfers } from "@/subscriptions/claim";
import {
  resetVerifierForTests,
  setVerifierForTests,
} from "@/subscriptions/jws-verifier";
import {
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionPeriod,
  SubscriptionStatus,
  upsertFromVerify,
  type AppleVerifyInput,
} from "@/subscriptions/repository";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const TEST_BUNDLE_ID = "app.convos.test";
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_START = new Date(Date.now() - 5 * DAY_MS);
const PERIOD_END = new Date(Date.now() + 25 * DAY_MS);
// The test env grants 2500 credits per plus-monthly period.
const PERIOD_CREDITS = 2500n;

// Bare app: auth + App Check + handler, without the rate limiters (their
// in-memory per-IP budget would starve these functional tests; wiring and
// the 429 envelope are covered in delete-endpoint-ratelimit.test.ts).
const makeApp = () => {
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

let signingPrivateKey: string;
const createdAccountIds: string[] = [];

// lastAuthAt is backdated: real accounts always carry a stamp (mint +
// migration backfill), and settlement defensively treats null as a veto.
const newAccount = async () => {
  const account = await prisma.account.create({
    data: { lastAuthAt: new Date(Date.now() - 60 * 60 * 1000) },
  });
  createdAccountIds.push(account.id);
  return account.id;
};

const tokenFor = (accountId: string) =>
  createJwtToken({ deviceId: `dev-${accountId.slice(0, 8)}`, accountId });

const signTransaction = async (overrides: Record<string, unknown> = {}) => {
  const payload = {
    transactionId: "9000000000000001",
    originalTransactionId: "9000000000000001",
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

/** Fake App Store Server API returning the given latest transaction. */
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

const appleInput = (
  accountId: string,
  otx: string,
  overrides: Partial<AppleVerifyInput> = {},
): AppleVerifyInput => ({
  provider: BillingProvider.apple,
  accountId,
  appAccountToken: "11111111-2222-3333-4444-555555555555",
  productId: "app.convos.subs.monthly",
  tier: SUBSCRIPTION_TIER_PLUS,
  period: SubscriptionPeriod.monthly,
  status: SubscriptionStatus.active,
  originalTransactionId: otx,
  transactionId: `tx-${otx}`,
  startedAt: PERIOD_START,
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  willRenew: true,
  isInTrial: false,
  environment: "sandbox",
  signedPayload: "jws-test-payload",
  ...overrides,
});

/** Verify + delete the owner, leaving a tombstoned lineage with escrow. */
const tombstoneViaDeletion = async (otx: string) => {
  const owner = await newAccount();
  await upsertFromVerify(appleInput(owner, otx));
  const { deleteAccount } = await import("@/accounts/deletion/service");
  const outcome = await deleteAccount({
    accountId: owner,
    operationId: randomUUID(),
  });
  expect(outcome).not.toBeNull();
  return owner;
};

const wipe = async () => {
  __setClaimAppCheckVerifierForTests(null);
  __setPendingTransferNotifierForTests(null);
  resetVerifierForTests();
  resetAppleApiClientForTests();
  delete process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED;
  delete process.env.CLAIM_CONTEST_WINDOW_HOURS;
  await prisma.deletionTask.deleteMany();
  await prisma.deletionRecord.deleteMany();
  await prisma.deletedIdentity.deleteMany();
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
  await prisma.authMethod.deleteMany();
  await prisma.account.deleteMany({
    where: { id: { not: "48a05ef4-4a71-57a0-957f-a3d410992b31" } },
  });
  createdAccountIds.length = 0;
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

afterEach(wipe);

type ClaimErrorBody = {
  code?: string;
  reason?: string;
  status?: string;
  contestEndsAt?: string;
  subscription?: Record<string, unknown>;
};

const body = (res: request.Response): ClaimErrorBody =>
  res.body as ClaimErrorBody;

const passAppCheck = () => {
  __setClaimAppCheckVerifierForTests(() => Promise.resolve());
};

const claimRequest = async (accountId: string, jws: string) =>
  request(makeApp())
    .post("/v2/accounts/me/subscription/claim")
    .set("X-Convos-AuthToken", await tokenFor(accountId))
    .set("X-Firebase-AppCheck", "limited-use-token")
    .send({ platform: "apple", jwsRepresentation: jws });

describe("claim App Check gate", () => {
  test("missing header: 403 app_check_required before any provider call", async () => {
    const accountId = await newAccount();
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/claim")
      .set("X-Convos-AuthToken", await tokenFor(accountId))
      .send({ platform: "apple", jwsRepresentation: "x" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "App attestation required",
      code: "app_check_required",
    });
  });

  test("rejected/replayed token: same single 403 code (no oracle)", async () => {
    const accountId = await newAccount();
    __setClaimAppCheckVerifierForTests(() =>
      Promise.reject(new Error("already consumed")),
    );
    const res = await claimRequest(accountId, "irrelevant");
    expect(res.status).toBe(403);
    expect(body(res).code).toBe("app_check_required");
  });
});

describe("tombstone restoration tier", () => {
  test("claim of a deleted owner's subscription releases the escrow exactly once", async () => {
    const otx = "9000000000000001";
    installLocalTestingVerifier();
    await tombstoneViaDeletion(otx);
    const claimer = await newAccount();
    passAppCheck();
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
    });
    installAppleStatuses({ otx, status: 1, signedLatest: jws });

    const res = await claimRequest(claimer, jws);
    expect(res.status).toBe(200);
    expect(body(res).subscription).toMatchObject({
      provider: "apple",
      tier: "plus",
      status: "active",
    });

    // The escrowed remainder (full untouched allotment) landed exactly once.
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);
    const lineage = await prisma.subscriptionLineage.findFirst({
      where: { provider: BillingProvider.apple, lineageKey: otx },
    });
    expect(lineage?.state).toBe("live");
    expect(lineage?.deletedAccountRef).toBeNull();
    const journal = await prisma.subscriptionTransfer.findFirst({
      where: { lineageId: lineage?.id ?? "", kind: "restore" },
    });
    expect(journal?.conservedCredits).toBe(PERIOD_CREDITS);
    // The funding registry has exactly ONE row for the period — release is
    // not a second grant.
    expect(
      await prisma.lineagePeriodGrant.count({
        where: { lineageId: lineage?.id ?? "" },
      }),
    ).toBe(1);

    // Replay: caller already owner -> 200, no double credit.
    const replay = await claimRequest(claimer, jws);
    expect(replay.status).toBe(200);
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);
  });

  test("verify after restoration succeeds for the new owner (lineage live again)", async () => {
    const otx = "9000000000000001";
    installLocalTestingVerifier();
    await tombstoneViaDeletion(otx);
    const claimer = await newAccount();
    passAppCheck();
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
    });
    installAppleStatuses({ otx, status: 1, signedLatest: jws });
    await claimRequest(claimer, jws);

    const result = await upsertFromVerify(appleInput(claimer, otx));
    expect(result.subscription.accountId).toBe(claimer);
  });

  test("not entitled now: 409 not_entitled, nothing restored", async () => {
    const otx = "9000000000000001";
    installLocalTestingVerifier();
    await tombstoneViaDeletion(otx);
    const claimer = await newAccount();
    passAppCheck();
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
    });
    installAppleStatuses({ otx, status: 2, signedLatest: jws });

    const res = await claimRequest(claimer, jws);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "subscription_claim_rejected",
      reason: "not_entitled",
    });
    expect(await getBalance(claimer)).toBe(0n);
  });

  test("stale artifact (not the latest transaction): 400 invalid_claim_proof", async () => {
    const otx = "9000000000000001";
    installLocalTestingVerifier();
    await tombstoneViaDeletion(otx);
    const claimer = await newAccount();
    passAppCheck();
    const staleJws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
    });
    const latestJws = await signTransaction({
      transactionId: "9000000000000099",
      originalTransactionId: otx,
    });
    installAppleStatuses({ otx, status: 1, signedLatest: latestJws });

    const res = await claimRequest(claimer, staleJws);
    expect(res.status).toBe(400);
    expect(body(res).code).toBe("invalid_claim_proof");
  });

  test("unknown provider key (no row, no tombstone): 404 subscription_not_found", async () => {
    const otx = "9000000000000042";
    installLocalTestingVerifier();
    const claimer = await newAccount();
    passAppCheck();
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
    });
    installAppleStatuses({ otx, status: 1, signedLatest: jws });

    const res = await claimRequest(claimer, jws);
    expect(res.status).toBe(404);
    expect(body(res).code).toBe("subscription_not_found");
  });
});

describe("live transfer tier", () => {
  const setupLiveOwner = async (otx: string) => {
    installLocalTestingVerifier();
    const owner = await newAccount();
    await upsertFromVerify(appleInput(owner, otx));
    return owner;
  };

  test("flag off (launch posture): 409 transfer_frozen", async () => {
    const otx = "9000000000000001";
    const owner = await setupLiveOwner(otx);
    const claimer = await newAccount();
    passAppCheck();
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
    });
    installAppleStatuses({ otx, status: 1, signedLatest: jws });

    const res = await claimRequest(claimer, jws);
    expect(res.status).toBe(409);
    expect(body(res).reason).toBe("transfer_frozen");
    // Ownership untouched.
    const row = await prisma.subscription.findFirst({
      where: { originalTransactionId: otx },
    });
    expect(row?.accountId).toBe(owner);
  });

  test("instant transfer (window 0) conserves credits exactly; promo stays put", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "0";
    const otx = "9000000000000001";
    const owner = await setupLiveOwner(otx);
    // Commingle promo credits into the owner wallet.
    await grant({
      accountId: owner,
      credits: 1000,
      kind: "manual",
      idempotencyKey: `promo_${owner}`,
      note: "promo",
    });
    const claimer = await newAccount();
    passAppCheck();
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
    });
    installAppleStatuses({ otx, status: 1, signedLatest: jws });

    const ownerBefore = await getBalance(owner);
    const res = await claimRequest(claimer, jws);
    expect(res.status).toBe(200);

    const ownerAfter = await getBalance(owner);
    const claimerAfter = await getBalance(claimer);
    // Conservation: what left the owner landed on the claimer.
    expect(ownerBefore - ownerAfter).toBe(claimerAfter);
    // The move is the subscription remainder only — promo credits survive.
    expect(claimerAfter).toBe(PERIOD_CREDITS);
    expect(ownerAfter).toBe(1000n);

    const row = await prisma.subscription.findFirst({
      where: { originalTransactionId: otx },
    });
    expect(row?.accountId).toBe(claimer);
  });

  test("second transfer inside the lineage cooldown: 409 cooldown; previous-owner undo is exempt and one-shot", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "0";
    const otx = "9000000000000001";
    const owner = await setupLiveOwner(otx);
    const claimer = await newAccount();
    const third = await newAccount();
    passAppCheck();
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
    });
    installAppleStatuses({ otx, status: 1, signedLatest: jws });

    expect((await claimRequest(claimer, jws)).status).toBe(200);

    // A third account inside the cooldown: rejected.
    const thirdRes = await claimRequest(third, jws);
    expect(thirdRes.status).toBe(409);
    expect(body(thirdRes).reason).toBe("cooldown");

    // The previous owner's undo is exempt from cooldown and succeeds.
    const undoRes = await claimRequest(owner, jws);
    expect(undoRes.status).toBe(200);
    const row = await prisma.subscription.findFirst({
      where: { originalTransactionId: otx },
    });
    expect(row?.accountId).toBe(owner);

    // Post-undo freeze: the next automated transfer is rejected.
    const afterUndo = await claimRequest(claimer, jws);
    expect(afterUndo.status).toBe(409);
    expect(body(afterUndo).reason).toBe("transfer_frozen");
  });

  test("contest window: 202 pending, push notifier fires, settlement executes after the window", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "72";
    const otx = "9000000000000001";
    const owner = await setupLiveOwner(otx);
    const claimer = await newAccount();
    passAppCheck();
    const notified: string[] = [];
    __setPendingTransferNotifierForTests(({ oldAccountId }) => {
      notified.push(oldAccountId);
      return Promise.resolve();
    });
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
    });
    installAppleStatuses({ otx, status: 1, signedLatest: jws });

    const res = await claimRequest(claimer, jws);
    expect(res.status).toBe(202);
    expect(body(res).status).toBe("pending");
    expect(new Date(body(res).contestEndsAt ?? "").getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(notified).toEqual([owner]);

    // A second claim while pending: 409 pending_contest.
    const other = await newAccount();
    const during = await claimRequest(other, jws);
    expect(during.status).toBe(409);
    expect(body(during).reason).toBe("pending_contest");

    // Window elapses (backdate) -> settlement executes the transfer.
    await prisma.subscriptionTransfer.updateMany({
      where: { status: "pending" },
      data: { contestEndsAt: new Date(Date.now() - 1000) },
    });
    const settled = await settlePendingTransfers();
    expect(settled.committed).toBe(1);
    const row = await prisma.subscription.findFirst({
      where: { originalTransactionId: otx },
    });
    expect(row?.accountId).toBe(claimer);
  });

  test("contest veto: authenticated old-account act after the pending row cancels it", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "72";
    const otx = "9000000000000001";
    const owner = await setupLiveOwner(otx);
    const claimer = await newAccount();
    passAppCheck();
    __setPendingTransferNotifierForTests(() => Promise.resolve());
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
    });
    installAppleStatuses({ otx, status: 1, signedLatest: jws });

    expect((await claimRequest(claimer, jws)).status).toBe(202);

    // Old account authenticates during the window (lastAuthAt stamp).
    // Anchored to the pending row's DB timestamp: the container's DB clock
    // can sit ahead of the JS clock, so "new Date()" is not reliably after
    // journal.createdAt.
    const pendingRow = await prisma.subscriptionTransfer.findFirstOrThrow({
      where: { status: "pending" },
    });
    await prisma.account.update({
      where: { id: owner },
      data: { lastAuthAt: new Date(pendingRow.createdAt.getTime() + 1000) },
    });
    await prisma.subscriptionTransfer.updateMany({
      where: { status: "pending" },
      data: { contestEndsAt: new Date(Date.now() - 1000) },
    });

    const settled = await settlePendingTransfers();
    expect(settled.cancelled).toBe(1);
    expect(settled.committed).toBe(0);
    const row = await prisma.subscription.findFirst({
      where: { originalTransactionId: otx },
    });
    expect(row?.accountId).toBe(owner);
  });
});
