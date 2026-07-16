import { randomUUID } from "node:crypto";
import { BillingProvider } from "@prisma/client";
import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import { deleteAccount } from "@/accounts/deletion/service";
import { __setClaimAppCheckVerifierForTests } from "@/api/v2/accounts/handlers/subscription-claim";
import { getBalance } from "@/payments";
import { upsertFromVerify } from "@/subscriptions/repository";
import { prisma } from "@/utils/prisma";
import {
  appleClaimRequest,
  appleInput,
  claimApp,
  installAppleStatuses,
  installLocalTestingVerifier,
  installReclaimHooks,
  newAccount,
  passAppCheck,
  PERIOD_CREDITS,
  signTransaction as signReclaimTransaction,
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
});
