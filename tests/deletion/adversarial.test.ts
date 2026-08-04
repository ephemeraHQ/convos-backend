import { randomUUID } from "node:crypto";
import { BillingProvider } from "@prisma/client";
import { describe, expect, test, vi } from "vitest";
import { deleteAccount } from "@/accounts/deletion/service";
import { __setClaimAppCheckVerifierForTests } from "@/api/v2/accounts/handlers/subscription-claim";
import { getBalance } from "@/payments";
import {
  LineageUnresolvedError,
  resolveOrCreateGoogleLineage,
} from "@/subscriptions/lineage";
import {
  compensateVoidedPurchase,
  upsertFromVerify,
  type GooglePlayVerifyInput,
} from "@/subscriptions/repository";
import { prisma } from "@/utils/prisma";
import {
  appleClaimRequest,
  appleInput,
  installAppleStatuses as installAppleStatusesFixture,
  installLocalTestingVerifier,
  installReclaimHooks,
  playInput as makePlayInput,
  newAccount,
  PERIOD_CREDITS,
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
