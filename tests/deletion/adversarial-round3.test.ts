import { randomUUID } from "node:crypto";
import { BillingProvider, Prisma } from "@prisma/client";
import express, { json } from "express";
import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import { deleteAccount } from "@/accounts/deletion/service";
import {
  IdentityBarredError,
  upsertAuthMethodAndAccount,
} from "@/accounts/repository";
import { __setClaimAppCheckVerifierForTests } from "@/api/v2/accounts/handlers/subscription-claim";
import { subscriptionVerifyHandler } from "@/api/v2/accounts/handlers/subscription-verify";
import { googlePlayWebhookRouter } from "@/api/v2/subscriptions/google-play-webhook.router";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { consume, getBalance } from "@/payments";
import { PlayNotificationType } from "@/subscriptions/google-play/notification-mapping";
import {
  setPlayApiFixtureForTests,
  type SubscriptionPurchaseV2,
} from "@/subscriptions/google-play/play-api";
import { PlaySubscriptionState } from "@/subscriptions/google-play/status";
import { setPubsubVerifierForTests } from "@/subscriptions/google-play/verifier";
import {
  LineageUnresolvedError,
  resolveOrCreateGoogleLineage,
} from "@/subscriptions/lineage";
import {
  applyNotification,
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionStatus,
  upsertFromVerify,
  type GooglePlayApplyNotificationInput,
} from "@/subscriptions/repository";
import {
  isRetryableTxConflict,
  withDeadlockRetry,
} from "@/utils/deadlock-retry";
import { prisma } from "@/utils/prisma";
import { setRuntimeConfig } from "@/utils/runtimeConfig";
import {
  APP_ACCOUNT_TOKEN,
  appleClaimRequest,
  installAppleStatusMap,
  installLocalTestingVerifier,
  installReclaimHooks,
  appleInput as makeAppleInput,
  newAccount,
  NEXT_PERIOD_END,
  PERIOD_CREDITS,
  PERIOD_END,
  PERIOD_START,
  playInput,
  PRODUCT_ID,
  signTransaction as signReclaimTransaction,
  tokenFor,
} from "./reclaim-fixtures";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");
const OTX = "7000000000000001";
const signTransaction = (overrides: Record<string, unknown> = {}) =>
  signReclaimTransaction(OTX, overrides);
const appleInput = (
  accountId: string,
  otx: string,
  appAccountToken = APP_ACCOUNT_TOKEN,
) => makeAppleInput(accountId, otx, { appAccountToken });

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
    productId: PRODUCT_ID,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: periodEnd,
    willRenew: true,
  },
});

type ClaimBody = { code?: string; reason?: string };
const claimRequest = (accountId: string, jws: string) =>
  appleClaimRequest(accountId, jws);

installReclaimHooks();

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
});

describe("cumulative custody cap across the full lifecycle", () => {
  test("spend -> delete -> restore -> renewal cycles stay within funded allotments", async () => {
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    const claimerB = await newAccount();
    const claimerC = await newAccount();
    const otx = "7000000000000001";
    await upsertFromVerify(appleInput(owner, otx));
    const originalJws = await signTransaction();
    installAppleStatusMap({
      [otx]: { status: 1, signedLatest: originalJws },
    });

    // Spending reduces the first period's durable custody cap before deletion.
    await consume({
      accountId: owner,
      usdCostMicros: 500_000n,
      idempotencyKey: `burn_${owner}`,
      requestId: "burn",
    });
    await deleteAccount({ accountId: owner, operationId: randomUUID() });
    expect((await claimRequest(claimerB, originalJws)).status).toBe(200);
    expect(await getBalance(claimerB)).toBe(PERIOD_CREDITS - 1000n);

    // A second deletion returns the reduced first-period remainder to escrow.
    await deleteAccount({ accountId: claimerB, operationId: randomUUID() });
    const nextStart = PERIOD_END;
    const renewalTx = "renewal-tx-1";
    const renewal = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otx,
      transactionId: renewalTx,
      notificationUUID: randomUUID(),
      notificationType: "DID_RENEW",
      signedPayload: "jws",
      update: {
        status: SubscriptionStatus.active,
        productId: "app.convos.subs.monthly",
        tier: SUBSCRIPTION_TIER_PLUS,
        currentPeriodStart: nextStart,
        currentPeriodEnd: NEXT_PERIOD_END,
        willRenew: true,
      },
    });
    expect(renewal.kind).toBe("tombstoned");

    const renewalJws = await signTransaction({
      transactionId: renewalTx,
      originalTransactionId: otx,
      purchaseDate: nextStart.getTime(),
      expiresDate: NEXT_PERIOD_END.getTime(),
    });
    installAppleStatusMap({
      [otx]: { status: 1, signedLatest: renewalJws },
    });
    expect((await claimRequest(claimerC, renewalJws)).status).toBe(200);
    expect(await getBalance(claimerC)).toBe(PERIOD_CREDITS);

    const periods = await prisma.lineagePeriodCustody.findMany({
      orderBy: { periodStart: "asc" },
    });
    expect(periods).toHaveLength(2);
    expect(periods[0]?.remainderCap).toBe(PERIOD_CREDITS - 1000n);
    expect(periods[0]?.ownerAccountId).toBeNull();
    expect(periods[1]?.remainderCap).toBe(PERIOD_CREDITS);
    expect(periods[1]?.ownerAccountId).toBe(claimerC);
    expect(
      periods.reduce((total, period) => total + period.remainderCap, 0n) +
        1000n,
    ).toBe(2n * PERIOD_CREDITS);
    expect(await prisma.lineagePeriodGrant.count()).toBe(2);
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
