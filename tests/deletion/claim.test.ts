import { randomUUID } from "node:crypto";
import { BillingProvider } from "@prisma/client";
import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import { deleteAccount } from "@/accounts/deletion/service";
import {
  __setClaimAppCheckVerifierForTests,
  __setPendingTransferNotifierForTests,
} from "@/api/v2/accounts/handlers/subscription-claim";
import { getBalance, grant } from "@/payments";
import { settlePendingTransfers } from "@/subscriptions/claim";
import { upsertFromVerify } from "@/subscriptions/repository";
import { prisma } from "@/utils/prisma";
import {
  appleClaimRequest,
  appleInput,
  claimApp,
  DAY_MS,
  installAppleStatuses,
  installLocalTestingVerifier,
  installReclaimHooks,
  newAccount,
  passAppCheck,
  PERIOD_CREDITS,
  signTransaction as signReclaimTransaction,
  signRenewalInfo,
  tokenFor,
} from "./reclaim-fixtures";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");
const OTX = "9000000000000001";
const signTransaction = (overrides: Record<string, unknown> = {}) =>
  signReclaimTransaction(OTX, overrides);

const tombstoneViaDeletion = async (otx: string) => {
  const owner = await newAccount();
  await upsertFromVerify(appleInput(owner, otx));
  const outcome = await deleteAccount({
    accountId: owner,
    operationId: randomUUID(),
  });
  expect(outcome).not.toBeNull();
  return owner;
};

type ClaimErrorBody = {
  code?: string;
  reason?: string;
  status?: string;
  contestEndsAt?: string;
  subscription?: Record<string, unknown>;
};
const body = (res: request.Response): ClaimErrorBody =>
  res.body as ClaimErrorBody;
const claimRequest = (accountId: string, jws: string) =>
  appleClaimRequest(accountId, jws, "limited-use-token");

installReclaimHooks();

describe("claim App Check gate", () => {
  test("missing header: 403 app_check_required before any provider call", async () => {
    const accountId = await newAccount();
    const res = await request(claimApp())
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

  test("billing-grace claim seeds grace and the renewal-info deadline, not expired", async () => {
    const otx = "9000000000000001";
    installLocalTestingVerifier();
    await tombstoneViaDeletion(otx);
    const claimer = await newAccount();
    passAppCheck();

    // The period lapsed and Apple is retrying billing: the latest
    // transaction is the lapsed one (expiresDate in the past), the grace
    // deadline lives only in the status item's renewal info. Seeding from
    // the transaction alone would restore an expired/free-tier row.
    const lapsedExpiry = Date.now() - 2 * DAY_MS;
    const graceDeadline = Date.now() + 14 * DAY_MS;
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
      expiresDate: lapsedExpiry,
    });
    const signedRenewal = await signRenewalInfo({
      originalTransactionId: otx,
      gracePeriodExpiresDate: graceDeadline,
    });
    installAppleStatuses({ otx, status: 4, signedLatest: jws, signedRenewal });

    const res = await claimRequest(claimer, jws);
    expect(res.status).toBe(200);
    expect(body(res).subscription).toMatchObject({
      provider: "apple",
      tier: "plus",
      status: "grace",
    });
    const row = await prisma.subscription.findFirstOrThrow({
      where: { originalTransactionId: otx },
    });
    expect(row.status).toBe("grace");
    expect(row.gracePeriodEnd?.getTime()).toBe(graceDeadline);
    expect(row.currentPeriodEnd.getTime()).toBe(lapsedExpiry);
    // The escrowed remainder still released exactly once.
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);
  });

  test("billing-grace claim without decodable renewal info: 400 fail closed", async () => {
    const otx = "9000000000000001";
    installLocalTestingVerifier();
    await tombstoneViaDeletion(otx);
    const claimer = await newAccount();
    passAppCheck();
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
      expiresDate: Date.now() - 2 * DAY_MS,
    });
    installAppleStatuses({ otx, status: 4, signedLatest: jws });

    const res = await claimRequest(claimer, jws);
    expect(res.status).toBe(400);
    expect(body(res).code).toBe("invalid_claim_proof");
    expect(await getBalance(claimer)).toBe(0n);
    const lineage = await prisma.subscriptionLineage.findFirstOrThrow({
      where: { lineageKey: otx },
    });
    expect(lineage.state).toBe("tombstoned");
  });

  test("billing-grace deadline already past: 409 not_entitled", async () => {
    const otx = "9000000000000001";
    installLocalTestingVerifier();
    await tombstoneViaDeletion(otx);
    const claimer = await newAccount();
    passAppCheck();
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
      expiresDate: Date.now() - 2 * DAY_MS,
    });
    const signedRenewal = await signRenewalInfo({
      originalTransactionId: otx,
      gracePeriodExpiresDate: Date.now() - DAY_MS,
    });
    installAppleStatuses({ otx, status: 4, signedLatest: jws, signedRenewal });

    const res = await claimRequest(claimer, jws);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "subscription_claim_rejected",
      reason: "not_entitled",
    });
    expect(await getBalance(claimer)).toBe(0n);
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

  test("unrecognized entitled product: 400 invalid_claim_proof", async () => {
    const otx = "9000000000000041";
    installLocalTestingVerifier();
    const claimer = await newAccount();
    passAppCheck();
    const jws = await signTransaction({
      transactionId: otx,
      originalTransactionId: otx,
      productId: "app.convos.subs.unknown.monthly",
    });
    installAppleStatuses({ otx, status: 1, signedLatest: jws });

    const res = await claimRequest(claimer, jws);
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

  test("fractional contest window (0.5) never means instant transfer: falls back to 72h pending", async () => {
    process.env.SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED = "true";
    // parseInt would truncate this to 0 (instant transfer, the outcome that
    // requires explicit security acceptance); the parser must reject it and
    // keep the 72h default.
    process.env.CLAIM_CONTEST_WINDOW_HOURS = "0.5";
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

    const res = await claimRequest(claimer, jws);
    expect(res.status).toBe(202);
    expect(body(res).status).toBe("pending");
    // The fallback window is 72h, not a truncated zero.
    const contestEndsAt = new Date(body(res).contestEndsAt ?? "").getTime();
    expect(contestEndsAt).toBeGreaterThan(Date.now() + 71 * 60 * 60 * 1000);
    // Ownership untouched while pending.
    const row = await prisma.subscription.findFirst({
      where: { originalTransactionId: otx },
    });
    expect(row?.accountId).toBe(owner);
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
