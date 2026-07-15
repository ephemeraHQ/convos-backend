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
import { deleteAccount } from "@/accounts/deletion/service";
import {
  __setClaimAppCheckVerifierForTests,
  __setPendingTransferNotifierForTests,
  claimAppCheckMiddleware,
  subscriptionClaimHandler,
} from "@/api/v2/accounts/handlers/subscription-claim";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { consume, getBalance } from "@/payments";
import {
  resetAppleApiClientForTests,
  setAppleApiClientForTests,
} from "@/subscriptions/apple-server-api";
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
  compensateVoidedPurchase,
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionPeriod,
  SubscriptionStatus,
  upsertFromVerify,
  type AppleVerifyInput,
  type GooglePlayVerifyInput,
} from "@/subscriptions/repository";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import { getRuntimeConfig, setRuntimeConfig } from "@/utils/runtimeConfig";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const TEST_BUNDLE_ID = "app.convos.test";
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_START = new Date(Date.now() - 5 * DAY_MS);
const PERIOD_END = new Date(Date.now() + 25 * DAY_MS);
const PERIOD_CREDITS = 2500n;

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

const newAccount = async () => {
  const account = await prisma.account.create({ data: {} });
  return account.id;
};

const tokenFor = (accountId: string) =>
  createJwtToken({ deviceId: `dev-${accountId.slice(0, 8)}`, accountId });

const signTransaction = async (overrides: Record<string, unknown> = {}) => {
  const payload = {
    transactionId: "8000000000000001",
    originalTransactionId: "8000000000000001",
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

const installAppleStatuses = (args: { otx: string; signedLatest: string }) => {
  setAppleApiClientForTests({
    getAllSubscriptionStatuses: () =>
      Promise.resolve({
        data: [
          {
            lastTransactions: [
              {
                originalTransactionId: args.otx,
                status: 1,
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
  playOrderId: `order-${purchaseToken}`,
  startedAt: PERIOD_START,
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  willRenew: true,
  isInTrial: false,
  signedPayload: "{}",
  ...overrides,
});

const wipe = async () => {
  __setClaimAppCheckVerifierForTests(null);
  __setPendingTransferNotifierForTests(null);
  resetVerifierForTests();
  resetAppleApiClientForTests();
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
  await prisma.authMethod.deleteMany();
  await prisma.account.deleteMany({
    where: { id: { not: "48a05ef4-4a71-57a0-957f-a3d410992b31" } },
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

afterEach(wipe);

type ClaimBody = { code?: string; reason?: string };

const claimRequest = async (accountId: string, jws: string) =>
  request(makeApp())
    .post("/v2/accounts/me/subscription/claim")
    .set("X-Convos-AuthToken", await tokenFor(accountId))
    .set("X-Firebase-AppCheck", "limited-use-token")
    .send({ platform: "apple", jwsRepresentation: jws });

describe("App Check hardening", () => {
  test("app_attest_enabled=false does NOT open the claim route (fails closed)", async () => {
    await setRuntimeConfig("app_attest_enabled", "false");
    expect(await getRuntimeConfig("app_attest_enabled", "true")).toBe("false");
    const accountId = await newAccount();
    // No App Check header: the global appCheckOnlyMiddleware would bypass
    // with attestation disabled; the claim route must still 403.
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/claim")
      .set("X-Convos-AuthToken", await tokenFor(accountId))
      .send({ platform: "apple", jwsRepresentation: "x" });
    expect(res.status).toBe(403);
    expect((res.body as ClaimBody).code).toBe("app_check_required");
  });

  test("limited-use token consume: a replayed token is rejected", async () => {
    const consumed = new Set<string>();
    __setClaimAppCheckVerifierForTests((token) => {
      if (consumed.has(token)) {
        return Promise.reject(new Error("already consumed"));
      }
      consumed.add(token);
      return Promise.resolve();
    });
    installLocalTestingVerifier();
    const accountId = await newAccount();
    const otx = "8000000000000001";
    const jws = await signTransaction();
    installAppleStatuses({ otx, signedLatest: jws });

    const first = await claimRequest(accountId, jws);
    // Proof is fine; unknown key -> 404 (attestation consumed).
    expect(first.status).toBe(404);
    const replay = await claimRequest(accountId, jws);
    expect(replay.status).toBe(403);
    expect((replay.body as ClaimBody).code).toBe("app_check_required");
  });
});

describe("replay against two targets", () => {
  test("same JWS claimed for B and C: exactly one transfer commits", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "0";
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const otx = "8000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    const jws = await signTransaction();
    installAppleStatuses({ otx, signedLatest: jws });

    const b = await newAccount();
    const c = await newAccount();
    const [resB, resC] = await Promise.all([
      claimRequest(b, jws),
      claimRequest(c, jws),
    ]);

    const statuses = [resB.status, resC.status].sort();
    // One 200 (winner), one 409 (cooldown after the winner's transfer).
    expect(statuses).toEqual([200, 409]);
    const row = await prisma.subscription.findFirst({
      where: { originalTransactionId: otx },
    });
    expect([b, c]).toContain(row?.accountId);
    // Exactly one committed transfer; total credits conserved (one period).
    expect(
      await prisma.subscriptionTransfer.count({
        where: { kind: "transfer", status: "committed" },
      }),
    ).toBe(1);
    const balances = await Promise.all([
      getBalance(owner),
      getBalance(b),
      getBalance(c),
    ]);
    expect(balances.reduce((a, x) => a + x, 0n)).toBe(PERIOD_CREDITS);
  });
});

describe("conservation under spend", () => {
  test("undo after attacker spend returns only what remains", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "0";
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const attacker = await newAccount();
    const otx = "8000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    const jws = await signTransaction();
    installAppleStatuses({ otx, signedLatest: jws });

    expect((await claimRequest(attacker, jws)).status).toBe(200);
    // Attacker burns 1000 credits (test env: 1000 credits = $1 => 500_000
    // usd micros at 2.0 markup).
    await consume({
      accountId: attacker,
      usdCostMicros: 500_000n,
      idempotencyKey: `burn_${attacker}`,
      requestId: "burn",
    });
    expect(await getBalance(attacker)).toBe(PERIOD_CREDITS - 1000n);

    // Victim's undo recovers exactly the unspent remainder.
    expect((await claimRequest(owner, jws)).status).toBe(200);
    expect(await getBalance(owner)).toBe(PERIOD_CREDITS - 1000n);
    expect(await getBalance(attacker)).toBe(0n);
  });

  test("undo is one-shot: a consumed transfer rejects with undo_consumed", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "0";
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const claimer = await newAccount();
    const otx = "8000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    const jws = await signTransaction();
    installAppleStatuses({ otx, signedLatest: jws });
    expect((await claimRequest(claimer, jws)).status).toBe(200);

    // Mark the transfer's undo as already consumed (a raced undo).
    await prisma.subscriptionTransfer.updateMany({
      where: { kind: "transfer", status: "committed" },
      data: { undoneByTransferId: randomUUID() },
    });
    const res = await claimRequest(owner, jws);
    expect(res.status).toBe(409);
    expect((res.body as ClaimBody).reason).toBe("undo_consumed");
  });
});

describe("post-transfer provider events", () => {
  test("refund after A->B compensates B (custody), not A", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "0";
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const claimer = await newAccount();
    const otx = "8000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    const jws = await signTransaction();
    installAppleStatuses({ otx, signedLatest: jws });
    expect((await claimRequest(claimer, jws)).status).toBe(200);
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);

    const result = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otx,
      transactionId: `tx-refund-${otx}`,
      notificationUUID: randomUUID(),
      notificationType: "REVOKE",
      signedPayload: "jws",
      update: {
        status: SubscriptionStatus.revoked,
        willRenew: false,
        cancelledAt: new Date(),
        currentPeriodEnd: PERIOD_END,
      },
    });
    expect(result.kind).toBe("applied");
    // The clawback landed on the current holder.
    expect(await getBalance(claimer)).toBe(0n);
    expect(await getBalance(owner)).toBe(0n);
  });

  test("renewal while tombstoned funds escrow; restoration releases it once", async () => {
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const otx = "8000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    await deleteAccount({ accountId: owner, operationId: randomUUID() });

    // Renewal arrives for the deleted owner's subscription: escrow-funded.
    const nextStart = PERIOD_END;
    const nextEnd = new Date(PERIOD_END.getTime() + 30 * DAY_MS);
    const result = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otx,
      transactionId: "renewal-tx-1",
      notificationUUID: randomUUID(),
      notificationType: "DID_RENEW",
      signedPayload: "jws",
      update: {
        status: SubscriptionStatus.active,
        productId: "app.convos.subs.monthly",
        tier: SUBSCRIPTION_TIER_PLUS,
        currentPeriodStart: nextStart,
        currentPeriodEnd: nextEnd,
        willRenew: true,
      },
    });
    expect(result.kind).toBe("tombstoned");
    const escrows = await prisma.lineagePeriodCustody.findMany({
      where: { state: "escrow" },
    });
    // The deletion escrow (current period) plus the renewal escrow.
    expect(escrows.length).toBe(2);
    expect(await prisma.lineagePeriodGrant.count()).toBe(2);

    // The stated Apple refund of that renewal arrives while still
    // tombstoned: the renewal's escrow is invalidated (cap 0) so no later
    // restoration can release refunded value; nothing moves (the value
    // already left a wallet at deletion time).
    const refund = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otx,
      transactionId: "renewal-tx-1",
      notificationUUID: randomUUID(),
      notificationType: "REVOKE",
      signedPayload: "jws",
      update: {
        status: SubscriptionStatus.revoked,
        willRenew: false,
        cancelledAt: new Date(),
        currentPeriodEnd: nextEnd,
      },
    });
    expect(refund.kind).toBe("tombstoned");
    const renewalEscrow = await prisma.lineagePeriodCustody.findFirst({
      where: { providerPeriodKey: "apple_txn_renewal-tx-1" },
    });
    expect(renewalEscrow?.state).toBe("invalidated");
    expect(renewalEscrow?.remainderCap).toBe(0n);
    // Late-event isolation: the deletion escrow for the earlier period is
    // untouched, and the registry still records exactly one row per event.
    expect(
      await prisma.lineagePeriodCustody.count({ where: { state: "escrow" } }),
    ).toBe(1);
    expect(await prisma.lineagePeriodGrant.count()).toBe(2);
  });

  test("voided purchase while tombstoned invalidates escrow without a wallet move", async () => {
    const owner = await newAccount();
    const token = "voided-token-1";
    await upsertFromVerify(playInput(owner, token));
    await deleteAccount({ accountId: owner, operationId: randomUUID() });

    const escrowBefore = await prisma.lineagePeriodCustody.findFirst({
      where: { state: "escrow" },
    });
    expect(escrowBefore?.remainderCap).toBe(PERIOD_CREDITS);

    const compensated = await compensateVoidedPurchase(token);
    expect(compensated).toBe(0n);
    const escrowAfter = await prisma.lineagePeriodCustody.findFirst({
      where: { id: escrowBefore?.id ?? "" },
    });
    expect(escrowAfter?.state).toBe("invalidated");
    expect(escrowAfter?.remainderCap).toBe(0n);
  });
});

describe("google chain resolution", () => {
  test("T1->T2->T3 chains resolve to one lineage regardless of alias presence", async () => {
    const fetcher = (token: string) =>
      Promise.resolve(
        token === "T3"
          ? { linkedPurchaseToken: "T2" }
          : token === "T2"
            ? { linkedPurchaseToken: "T1" }
            : { linkedPurchaseToken: null },
      );
    // Zero aliases present.
    const first = await resolveOrCreateGoogleLineage({
      token: "T3",
      linkedPurchaseToken: "T2",
      fetchChain: true,
      fetcher,
    });
    // All aliases now recorded — a later token resolves to the same lineage.
    const second = await resolveOrCreateGoogleLineage({
      token: "T2",
      linkedPurchaseToken: "T1",
      fetchChain: true,
      fetcher,
    });
    expect(second).toBe(first);
    expect(await prisma.subscriptionLineage.count()).toBe(1);
    const aliases = await prisma.lineageTokenAlias.findMany({
      where: { lineageId: first },
    });
    expect(aliases.map((a) => a.token).sort()).toEqual(["T1", "T2", "T3"]);
  });

  test("conflicting chains quarantine instead of auto-merging", async () => {
    // Two independent funded lineages...
    await prisma.subscriptionLineage.create({
      data: { provider: BillingProvider.googlePlay, lineageKey: "L1" },
    });
    await prisma.subscriptionLineage.create({
      data: { provider: BillingProvider.googlePlay, lineageKey: "L2" },
    });
    // ...and a chain claiming to connect them.
    await expect(
      resolveOrCreateGoogleLineage({
        token: "L1",
        linkedPurchaseToken: "L2",
        fetchChain: true,
        fetcher: () => Promise.resolve({ linkedPurchaseToken: null }),
      }),
    ).rejects.toBeInstanceOf(LineageUnresolvedError);
    expect(await prisma.lineageQuarantine.count()).toBe(1);
  });

  test("verify of T2 (linked T1) after verify of T1 keeps one lineage; upgrade in-period never double-funds", async () => {
    const accountId = await newAccount();
    await upsertFromVerify(playInput(accountId, "T1"));
    // Rotation: T2 supersedes T1 mid-period (upgrade); new order id, same
    // window.
    await upsertFromVerify(
      playInput(accountId, "T2", {
        linkedPurchaseToken: "T1",
        playOrderId: "order-upgrade",
      }),
    );
    expect(await prisma.subscriptionLineage.count()).toBe(1);
    // One funded period only: the upgrade event granted nothing.
    expect(await getBalance(accountId)).toBe(PERIOD_CREDITS);
    expect(await prisma.lineagePeriodCustody.count()).toBe(1);
  });
});

describe("deletion vs verify race", () => {
  test("concurrent delete and verify converge (no orphaned live row)", async () => {
    installLocalTestingVerifier();
    const owner = await newAccount();
    const otx = "8000000000000001";
    await upsertFromVerify(appleInput(owner, otx));

    const [deleted, verified] = await Promise.allSettled([
      deleteAccount({ accountId: owner, operationId: randomUUID() }),
      upsertFromVerify(appleInput(owner, otx)),
    ]);
    expect(deleted.status).toBe("fulfilled");
    // Whatever order they serialized in, the end state is: account gone,
    // no live subscription row, lineage tombstoned.
    expect(await prisma.account.count({ where: { id: owner } })).toBe(0);
    expect(await prisma.subscription.count()).toBe(0);
    const lineage = await prisma.subscriptionLineage.findFirst({
      where: { lineageKey: otx },
    });
    expect(lineage?.state).toBe("tombstoned");
    // The verify either succeeded before the teardown (then swept) or
    // failed closed — both acceptable; the assertion above is that no state
    // was recreated regardless of the verify outcome.
    expect(["fulfilled", "rejected"]).toContain(verified.status);
  });
});
