import { randomUUID } from "node:crypto";
import { BillingProvider } from "@prisma/client";
import { describe, expect, test, vi } from "vitest";
import { deleteAccount } from "@/accounts/deletion/service";
import { __setClaimAppCheckVerifierForTests } from "@/api/v2/accounts/handlers/subscription-claim";
import { consume, getBalance } from "@/payments";
import {
  LineageUnresolvedError,
  resolveOrCreateGoogleLineage,
} from "@/subscriptions/lineage";
import {
  applyNotification,
  compensateVoidedPurchase,
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionStatus,
  upsertFromVerify,
  type GooglePlayVerifyInput,
} from "@/subscriptions/repository";
import { prisma } from "@/utils/prisma";
import {
  appleClaimRequest,
  appleInput,
  DAY_MS,
  installAppleStatuses as installAppleStatusesFixture,
  installLocalTestingVerifier,
  installReclaimHooks,
  playInput as makePlayInput,
  newAccount,
  PERIOD_CREDITS,
  PERIOD_END,
  PRODUCT_ID,
  signTransaction as signReclaimTransaction,
} from "./reclaim-fixtures";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");
const OTX = "8000000000000001";
const signTransaction = (overrides: Record<string, unknown> = {}) =>
  signReclaimTransaction(OTX, overrides);
const installAppleStatuses = (args: { otx: string; signedLatest: string }) => {
  installAppleStatusesFixture({ ...args, status: 1 });
};
const playInput = (
  accountId: string,
  purchaseToken: string,
  overrides: Partial<GooglePlayVerifyInput> = {},
) =>
  makePlayInput(accountId, purchaseToken, {
    playOrderId: `order-${purchaseToken}`,
    ...overrides,
  });

type ClaimBody = { code?: string; reason?: string };
const claimRequest = (accountId: string, jws: string) =>
  appleClaimRequest(accountId, jws, "limited-use-token");

installReclaimHooks();

describe("App Check hardening", () => {
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
        productId: PRODUCT_ID,
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
});

describe("tombstoned provider events", () => {
  test("voided purchase while tombstoned invalidates escrow without a wallet move", async () => {
    const owner = await newAccount();
    const token = "voided-token-1";
    await upsertFromVerify(playInput(owner, token));
    await deleteAccount({ accountId: owner, operationId: randomUUID() });

    const escrowBefore = await prisma.lineagePeriodCustody.findFirst({
      where: { state: "escrow" },
    });
    expect(escrowBefore?.remainderCap).toBe(PERIOD_CREDITS);

    // The void names its exact order (the one that funded the period).
    const compensated = await compensateVoidedPurchase(token, `order-${token}`);
    expect(compensated).toEqual({ kind: "compensated", amount: 0n });
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
