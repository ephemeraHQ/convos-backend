import { randomUUID } from "node:crypto";
import { BillingProvider } from "@prisma/client";
import express, { json } from "express";
import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import { deleteAccount } from "@/accounts/deletion/service";
import { __setClaimAppCheckVerifierForTests } from "@/api/v2/accounts/handlers/subscription-claim";
import { googlePlayWebhookRouter } from "@/api/v2/subscriptions/google-play-webhook.router";
import {
  __setClaimCeilingIncrementForTests,
  makeClaimGlobalCeiling,
} from "@/middleware/claimGlobalCeiling";
import { pinoMiddleware } from "@/middleware/pino";
import { getBalance } from "@/payments";
import { evaluateClaimable } from "@/subscriptions/claim-eligibility";
import { setPlayApiFixtureForTests } from "@/subscriptions/google-play/play-api";
import { setPubsubVerifierForTests } from "@/subscriptions/google-play/verifier";
import { LineageUnresolvedError } from "@/subscriptions/lineage";
import { runReclaimReconciliationSweep } from "@/subscriptions/reconciliation";
import {
  compensateVoidedPurchase,
  SubscriptionStatus,
  upsertFromVerify,
} from "@/subscriptions/repository";
import { prisma } from "@/utils/prisma";
import {
  installReclaimHooks,
  newAccount,
  NEXT_PERIOD_END,
  PERIOD_CREDITS,
  playClaimRequest,
  playInput,
  playPurchase,
} from "./reclaim-fixtures";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");
const rtdnApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.use("/v2/webhooks/google-play", googlePlayWebhookRouter);
  return app;
};

installReclaimHooks();

describe("google provider claims are permanently fail-closed", () => {
  test("a schema-valid google claim is rejected before provider lookup", async () => {
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

    // Verify never advertises a Google lineage as claimable.
    expect(
      await evaluateClaimable({
        provider: BillingProvider.googlePlay,
        keys: [token],
      }),
    ).toBe(false);
  });
});

describe("live funding with a conflicting google alias", () => {
  test("the atomic resolver quarantines the conflict before funding", async () => {
    const owner = await newAccount();
    const tOld = "conflict-told";
    const tNew = "conflict-tnew";
    await upsertFromVerify(playInput(owner, tOld));
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
    await expect(
      upsertFromVerify(
        playInput(owner, tNew, {
          linkedPurchaseToken: tOld,
          playOrderId: "GPA.conflict..1",
        }),
      ),
    ).rejects.toBeInstanceOf(LineageUnresolvedError);
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
    expect(l1.state).toBe("live");
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
