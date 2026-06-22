import { randomUUID } from "node:crypto";
import { BillingProvider, SubscriptionStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runEntitlementReconcile } from "@/subscriptions/reconcile/service";
import { isEntitledSubscription } from "@/subscriptions/status";
import { prisma } from "@/utils/prisma";

// MOCK the provider clients. Apple's getSubscriptionStatuses + the JWS
// verifiers are stubbed so no real App Store Server API call is made. Google's
// play-api is mocked at the module boundary so `googleapis` (an absent optional
// dep in this env) is never loaded — the dynamic import inside the reconcile
// service resolves to this mock.
const getSubscriptionStatuses = vi.fn<(id: string) => Promise<unknown>>();
vi.mock("@/subscriptions/apple-server-api", () => ({
  getSubscriptionStatuses: (id: string) => getSubscriptionStatuses(id),
}));

const verifyAndDecodeTransaction = vi.fn<(jws: string) => Promise<unknown>>();
const verifyAndDecodeRenewalInfo = vi.fn<(jws: string) => Promise<unknown>>();
vi.mock("@/subscriptions/jws-verifier", () => ({
  verifyAndDecodeTransaction: (jws: string) => verifyAndDecodeTransaction(jws),
  verifyAndDecodeRenewalInfo: (jws: string) => verifyAndDecodeRenewalInfo(jws),
}));

const fetchSubscriptionPurchaseV2 =
  vi.fn<(token: string) => Promise<unknown>>();
vi.mock("@/subscriptions/google-play/play-api", () => ({
  fetchSubscriptionPurchaseV2: (token: string) =>
    fetchSubscriptionPurchaseV2(token),
}));

// Apple status enum (mirrors @apple/app-store-server-library Status).
const APPLE_STATUS_ACTIVE = 1;
const APPLE_STATUS_EXPIRED = 2;
const APPLE_STATUS_BILLING_RETRY = 3;
const APPLE_STATUS_BILLING_GRACE = 4;
const APPLE_STATUS_REVOKED = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 5, 22, 12, 0, 0));

const tracker: string[] = [];

const newAccount = async (): Promise<string> => {
  const acct = await prisma.account.create({ data: {} });
  tracker.push(acct.id);
  return acct.id;
};

const seedAppleSub = async (opts: {
  accountId: string;
  status?: SubscriptionStatus;
  currentPeriodEnd: Date;
  currentPeriodStart?: Date;
  gracePeriodEnd?: Date | null;
  updatedAt?: Date;
}): Promise<string> => {
  const sub = await prisma.subscription.create({
    data: {
      accountId: opts.accountId,
      provider: BillingProvider.apple,
      productId: "app.convos.subs.monthly",
      tier: "plus",
      period: "monthly",
      status: opts.status ?? SubscriptionStatus.active,
      originalTransactionId: `otx-${randomUUID()}`,
      appAccountToken: randomUUID(),
      startedAt: new Date(opts.currentPeriodEnd.getTime() - 30 * DAY_MS),
      currentPeriodStart:
        opts.currentPeriodStart ??
        new Date(opts.currentPeriodEnd.getTime() - 30 * DAY_MS),
      currentPeriodEnd: opts.currentPeriodEnd,
      gracePeriodEnd: opts.gracePeriodEnd ?? null,
      willRenew: true,
      isInTrial: false,
      environment: "production",
    },
  });
  return sub.id;
};

const seedGoogleSub = async (opts: {
  accountId: string;
  status?: SubscriptionStatus;
  currentPeriodEnd: Date;
  gracePeriodEnd?: Date | null;
}): Promise<string> => {
  const sub = await prisma.subscription.create({
    data: {
      accountId: opts.accountId,
      provider: BillingProvider.googlePlay,
      productId: "app.convos.subs.monthly",
      tier: "plus",
      period: "monthly",
      status: opts.status ?? SubscriptionStatus.active,
      purchaseToken: `ptok-${randomUUID()}`,
      obfuscatedAccountId: randomUUID(),
      startedAt: new Date(opts.currentPeriodEnd.getTime() - 30 * DAY_MS),
      currentPeriodStart: new Date(
        opts.currentPeriodEnd.getTime() - 30 * DAY_MS,
      ),
      currentPeriodEnd: opts.currentPeriodEnd,
      gracePeriodEnd: opts.gracePeriodEnd ?? null,
      willRenew: true,
      isInTrial: false,
    },
  });
  return sub.id;
};

/** Build an Apple StatusResponse whose lastTransactions carries the per-item
 *  status enum and the JWS strings for the given originalTransactionId. The JWS
 *  strings are opaque — the verifier mocks map them to decoded payloads. */
const appleStatusResponse = (
  originalTransactionId: string,
  opts: {
    status: number;
    txJws?: string;
    renewalJws?: string;
  },
) => ({
  data: [
    {
      lastTransactions: [
        {
          originalTransactionId,
          status: opts.status,
          ...(opts.txJws ? { signedTransactionInfo: opts.txJws } : {}),
          ...(opts.renewalJws ? { signedRenewalInfo: opts.renewalJws } : {}),
        },
      ],
    },
  ],
});

const decodedTransaction = (opts: {
  originalTransactionId: string;
  expiresDate: number;
  purchaseDate?: number;
  revocationDate?: number;
}) => ({
  originalTransactionId: opts.originalTransactionId,
  transactionId: `tx-${randomUUID()}`,
  productId: "app.convos.subs.monthly",
  purchaseDate: opts.purchaseDate ?? opts.expiresDate - 30 * DAY_MS,
  expiresDate: opts.expiresDate,
  ...(opts.revocationDate ? { revocationDate: opts.revocationDate } : {}),
});

beforeEach(() => {
  getSubscriptionStatuses.mockReset();
  verifyAndDecodeTransaction.mockReset();
  verifyAndDecodeRenewalInfo.mockReset();
  fetchSubscriptionPurchaseV2.mockReset();
});

afterEach(async () => {
  for (const accountId of tracker) {
    await prisma.billingReceipt.deleteMany({
      where: { subscription: { accountId } },
    });
    await prisma.subscription.deleteMany({ where: { accountId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
  }
  tracker.length = 0;
});

describe("runEntitlementReconcile", () => {
  test("(1) stale window + Apple status=active newer window → refreshed + entitled", async () => {
    const accountId = await newAccount();
    // Stale: ends in ~1 day (within the 3-day at-risk window).
    const staleEnd = new Date(NOW.getTime() + 1 * DAY_MS);
    const subId = await seedAppleSub({ accountId, currentPeriodEnd: staleEnd });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    // Provider truth: renewed, expires 30 days out, status ACTIVE.
    const newExpiry = NOW.getTime() + 30 * DAY_MS;
    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_ACTIVE,
        txJws: "jws-renewed",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: newExpiry,
      }),
    );

    const summary = await runEntitlementReconcile({ now: NOW });

    expect(summary.scanned).toBe(1);
    expect(summary.refreshed).toHaveLength(1);
    expect(summary.errors).toHaveLength(0);

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.currentPeriodEnd.getTime()).toBe(newExpiry);
    expect(after.status).toBe(SubscriptionStatus.active);
    expect(isEntitledSubscription(after, NOW)).toBe(true);
  });

  test("(2) Apple status=3 billing-retry → NOT wrongly expired, grace cleared", async () => {
    const accountId = await newAccount();
    // Billing-retry sub: paid period already lapsed (renewal failed). Carries a
    // stale grace deadline that MUST be cleared on the transition.
    const lapsedEnd = new Date(NOW.getTime() - 2 * DAY_MS);
    const staleGrace = new Date(NOW.getTime() + 5 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.grace,
      currentPeriodEnd: lapsedEnd,
      gracePeriodEnd: staleGrace,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    // Provider: status=3, last transaction's expiresDate is in the past (the
    // lapsed paid period). The OLD cron derived `expired` from this — the bug.
    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_BILLING_RETRY,
        txJws: "jws-retry",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: lapsedEnd.getTime(),
      }),
    );

    await runEntitlementReconcile({ now: NOW });

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    // grace → billingRetry (provider truth), NOT expired from the txn.
    expect(after.status).toBe(SubscriptionStatus.billingRetry);
    expect(after.status).not.toBe(SubscriptionStatus.expired);
    // Window not regressed / fabricated.
    expect(after.currentPeriodEnd.getTime()).toBe(lapsedEnd.getTime());
    // B-N2: stale grace deadline cleared, so status.ts governs by
    // currentPeriodEnd — NOT entitled past the lapsed paid period.
    expect(after.gracePeriodEnd).toBeNull();
    expect(isEntitledSubscription(after, NOW)).toBe(false);
  });

  test("(2b) Apple status=3 from a previously-active row → billingRetry, NOT expired", async () => {
    const accountId = await newAccount();
    // Row is still `active` in DB (the DID_FAIL_TO_RENEW webhook was dropped),
    // paid period within the at-risk window.
    const lapsedEnd = new Date(NOW.getTime() - 1 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodEnd: lapsedEnd,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_BILLING_RETRY,
        txJws: "jws-retry",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: lapsedEnd.getTime(),
      }),
    );

    await runEntitlementReconcile({ now: NOW });

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    // active → billingRetry (the provider's truth), NOT expired.
    expect(after.status).toBe(SubscriptionStatus.billingRetry);
    expect(after.status).not.toBe(SubscriptionStatus.expired);
    // billingRetry with a null deadline → status.ts governs by currentPeriodEnd.
    expect(after.gracePeriodEnd).toBeNull();
    // Paid period already lapsed → not entitled.
    expect(isEntitledSubscription(after, NOW)).toBe(false);
  });

  test("(3) Apple status=4 grace → entitled + gracePeriodEnd=gracePeriodExpiresDate", async () => {
    const accountId = await newAccount();
    const lapsedEnd = new Date(NOW.getTime() - 1 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodEnd: lapsedEnd,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    // Grace deadline: 5 days from now (the real access deadline). The cron has
    // the REAL deadline via renewalInfo — better than the webhook's
    // expiresDate fallback.
    const graceDeadline = NOW.getTime() + 5 * DAY_MS;
    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_BILLING_GRACE,
        txJws: "jws-grace",
        renewalJws: "jws-renewal-grace",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: lapsedEnd.getTime(),
      }),
    );
    verifyAndDecodeRenewalInfo.mockResolvedValue({
      gracePeriodExpiresDate: graceDeadline,
    });

    const summary = await runEntitlementReconcile({ now: NOW });

    expect(summary.refreshed).toHaveLength(1);
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.status).toBe(SubscriptionStatus.grace);
    // B-N1: the SINGLE grace field carries the real deadline.
    expect(after.gracePeriodEnd?.getTime()).toBe(graceDeadline);
    // The entitlement VERDICT (not just the column) — this is the gap that hid
    // the original B-N1 bug.
    expect(isEntitledSubscription(after, NOW)).toBe(true);
    // ...and past the grace deadline the SAME row reads expired.
    const pastDeadline = new Date(graceDeadline + 1 * DAY_MS);
    expect(isEntitledSubscription(after, pastDeadline)).toBe(false);
  });

  test("(3b) Apple status=4 grace but NO gracePeriodExpiresDate → fail-SAFE, row UNCHANGED", async () => {
    const accountId = await newAccount();
    const lapsedEnd = new Date(NOW.getTime() - 1 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodEnd: lapsedEnd,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    const before = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_BILLING_GRACE,
        txJws: "jws-grace",
        renewalJws: "jws-renewal-nograce",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: lapsedEnd.getTime(),
      }),
    );
    // Renewal info present but WITHOUT gracePeriodExpiresDate.
    verifyAndDecodeRenewalInfo.mockResolvedValue({});

    const summary = await runEntitlementReconcile({ now: NOW });

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    // S-N3: the cron leaves the row UNCHANGED (fail-safe), it does NOT actively
    // write `expired`. Counted as an unresolved error and retried next run.
    expect(after.status).toBe(before.status);
    expect(after.status).not.toBe(SubscriptionStatus.expired);
    expect(after.currentPeriodEnd.getTime()).toBe(
      before.currentPeriodEnd.getTime(),
    );
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(summary.refreshed).toHaveLength(0);
    expect(summary.errors).toHaveLength(1);
  });

  test("(4) Apple status=2 expired → row expired, grace cleared, window kept (monotonic)", async () => {
    const accountId = await newAccount();
    const staleEnd = new Date(NOW.getTime() + 1 * DAY_MS);
    const staleGrace = new Date(NOW.getTime() + 3 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.grace,
      currentPeriodEnd: staleEnd,
      gracePeriodEnd: staleGrace,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    const expiredAt = NOW.getTime() - 2 * DAY_MS;
    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_EXPIRED,
        txJws: "jws-expired",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: expiredAt,
      }),
    );

    const summary = await runEntitlementReconcile({ now: NOW });

    expect(summary.refreshed).toHaveLength(1);
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.status).toBe(SubscriptionStatus.expired);
    // Monotonic guard: the regressing (older) window from the expired arm is
    // dropped; currentPeriodEnd is NOT rolled backwards.
    expect(after.currentPeriodEnd.getTime()).toBe(staleEnd.getTime());
    // B-N2: grace cleared.
    expect(after.gracePeriodEnd).toBeNull();
    expect(isEntitledSubscription(after, NOW)).toBe(false);
  });

  test("(4b) Apple status=5 revoked → row revoked, grace cleared, not entitled", async () => {
    const accountId = await newAccount();
    const staleEnd = new Date(NOW.getTime() + 1 * DAY_MS);
    const staleGrace = new Date(NOW.getTime() + 3 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.grace,
      currentPeriodEnd: staleEnd,
      gracePeriodEnd: staleGrace,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_REVOKED,
        txJws: "jws-revoked",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: staleEnd.getTime(),
        revocationDate: NOW.getTime() - 1 * DAY_MS,
      }),
    );

    await runEntitlementReconcile({ now: NOW });

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.status).toBe(SubscriptionStatus.revoked);
    expect(after.gracePeriodEnd).toBeNull();
    expect(isEntitledSubscription(after, NOW)).toBe(false);
  });

  test("(5) provider call throws → row UNCHANGED, counted errored, batch continues", async () => {
    const accountId = await newAccount();
    const staleEnd = new Date(NOW.getTime() + 1 * DAY_MS);
    const subId = await seedAppleSub({ accountId, currentPeriodEnd: staleEnd });

    getSubscriptionStatuses.mockRejectedValue(new Error("503 throttled"));

    const summary = await runEntitlementReconcile({ now: NOW });

    expect(summary.scanned).toBe(1);
    expect(summary.refreshed).toHaveLength(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].subscriptionId).toBe(subId);

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.currentPeriodEnd.getTime()).toBe(staleEnd.getTime());
    expect(after.status).toBe(SubscriptionStatus.active);
  });

  test("(6) up-to-date sub far from expiry → not even scanned (no-op)", async () => {
    const accountId = await newAccount();
    const healthyEnd = new Date(NOW.getTime() + 25 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      currentPeriodEnd: healthyEnd,
    });

    const summary = await runEntitlementReconcile({ now: NOW });

    expect(summary.scanned).toBe(0);
    expect(getSubscriptionStatuses).not.toHaveBeenCalled();

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.currentPeriodEnd.getTime()).toBe(healthyEnd.getTime());
  });

  test("(7) replay/idempotency → provider truth == stored → no change", async () => {
    const accountId = await newAccount();
    const end = new Date(NOW.getTime() + 1 * DAY_MS);
    const subId = await seedAppleSub({ accountId, currentPeriodEnd: end });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_ACTIVE,
        txJws: "jws-same",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: end.getTime(),
      }),
    );

    const before = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    const summary = await runEntitlementReconcile({ now: NOW });
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    expect(summary.refreshed).toHaveLength(0);
    expect(summary.noOp).toBe(1);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.currentPeriodEnd.getTime()).toBe(end.getTime());
  });

  test("(7b) provider window OLDER than stored (still active) → never regressed (monotonic)", async () => {
    const accountId = await newAccount();
    const storedEnd = new Date(NOW.getTime() + 2 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      currentPeriodEnd: storedEnd,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    const olderActive = NOW.getTime() + 1 * DAY_MS;
    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_ACTIVE,
        txJws: "jws-older",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: olderActive,
      }),
    );

    const summary = await runEntitlementReconcile({ now: NOW });
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    expect(summary.refreshed).toHaveLength(0);
    expect(summary.noOp).toBe(1);
    expect(after.currentPeriodEnd.getTime()).toBe(storedEnd.getTime());
  });

  test("(8) Google IN_GRACE_PERIOD → entitled + gracePeriodEnd=expiryTime", async () => {
    const accountId = await newAccount();
    const lapsedEnd = new Date(NOW.getTime() - 1 * DAY_MS);
    const subId = await seedGoogleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodEnd: lapsedEnd,
    });

    // Google extends expiryTime to the grace deadline.
    const graceDeadline = NOW.getTime() + 4 * DAY_MS;
    fetchSubscriptionPurchaseV2.mockResolvedValue({
      subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
      startTime: new Date(graceDeadline - 30 * DAY_MS).toISOString(),
      latestOrderId: "GPA.grace-1",
      lineItems: [
        {
          productId: "app.convos.subs.monthly",
          expiryTime: new Date(graceDeadline).toISOString(),
          autoRenewingPlan: { autoRenewEnabled: true },
        },
      ],
    });

    const summary = await runEntitlementReconcile({ now: NOW });

    expect(summary.refreshed).toHaveLength(1);
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.status).toBe(SubscriptionStatus.grace);
    // B-N1: gracePeriodEnd = the extended expiryTime (the single grace field).
    expect(after.gracePeriodEnd?.getTime()).toBe(graceDeadline);
    expect(after.currentPeriodEnd.getTime()).toBe(graceDeadline);
    expect(isEntitledSubscription(after, NOW)).toBe(true);
  });

  test("(9) Google ON_HOLD → NOT entitled, grace cleared, window not advanced", async () => {
    const accountId = await newAccount();
    const lapsedEnd = new Date(NOW.getTime() - 1 * DAY_MS);
    const staleGrace = new Date(NOW.getTime() + 5 * DAY_MS);
    const subId = await seedGoogleSub({
      accountId,
      status: SubscriptionStatus.grace,
      currentPeriodEnd: lapsedEnd,
      gracePeriodEnd: staleGrace,
    });

    fetchSubscriptionPurchaseV2.mockResolvedValue({
      subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD",
      startTime: new Date(lapsedEnd.getTime() - 30 * DAY_MS).toISOString(),
      latestOrderId: "GPA.hold-1",
      lineItems: [
        {
          productId: "app.convos.subs.monthly",
          // Even if Google reports a future expiryTime, ON_HOLD is NOT entitled
          // and must NOT advance our window.
          expiryTime: new Date(NOW.getTime() + 10 * DAY_MS).toISOString(),
          autoRenewingPlan: { autoRenewEnabled: false },
        },
      ],
    });

    await runEntitlementReconcile({ now: NOW });

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.status).toBe(SubscriptionStatus.billingRetry);
    // B-N2: stale grace deadline cleared → status.ts governs by
    // currentPeriodEnd.
    expect(after.gracePeriodEnd).toBeNull();
    // Window NOT advanced to the (irrelevant) ON_HOLD expiryTime.
    expect(after.currentPeriodEnd.getTime()).toBe(lapsedEnd.getTime());
    // Lapsed paid period + cleared grace → not entitled.
    expect(isEntitledSubscription(after, NOW)).toBe(false);
  });

  test("(9b) Google PAUSED → NOT entitled, grace cleared", async () => {
    const accountId = await newAccount();
    const lapsedEnd = new Date(NOW.getTime() - 1 * DAY_MS);
    const staleGrace = new Date(NOW.getTime() + 5 * DAY_MS);
    const subId = await seedGoogleSub({
      accountId,
      status: SubscriptionStatus.grace,
      currentPeriodEnd: lapsedEnd,
      gracePeriodEnd: staleGrace,
    });

    fetchSubscriptionPurchaseV2.mockResolvedValue({
      subscriptionState: "SUBSCRIPTION_STATE_PAUSED",
      startTime: new Date(lapsedEnd.getTime() - 30 * DAY_MS).toISOString(),
      latestOrderId: "GPA.paused-1",
      pausedStateContext: {
        autoResumingTime: new Date(NOW.getTime() + 20 * DAY_MS).toISOString(),
      },
      lineItems: [
        {
          productId: "app.convos.subs.monthly",
          expiryTime: new Date(NOW.getTime() + 10 * DAY_MS).toISOString(),
          autoRenewingPlan: { autoRenewEnabled: false },
        },
      ],
    });

    await runEntitlementReconcile({ now: NOW });

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.status).toBe(SubscriptionStatus.billingRetry);
    expect(after.gracePeriodEnd).toBeNull();
    expect(after.currentPeriodEnd.getTime()).toBe(lapsedEnd.getTime());
    expect(isEntitledSubscription(after, NOW)).toBe(false);
  });

  test("(10) concurrency: row changed mid-run → updatedAt-guarded write SKIPS", async () => {
    const accountId = await newAccount();
    const staleEnd = new Date(NOW.getTime() + 1 * DAY_MS);
    const subId = await seedAppleSub({ accountId, currentPeriodEnd: staleEnd });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    // Provider says renewed → the cron WANTS to write a 30-day window.
    const cronExpiry = NOW.getTime() + 30 * DAY_MS;
    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_ACTIVE,
        txJws: "jws-cron",
      }),
    );
    // Between scan and write, a fresher webhook lands (later window). We
    // simulate it by mutating the row inside the verify mock — which runs after
    // findMany snapshotted `updatedAt` but before the guarded updateMany.
    const webhookExpiry = NOW.getTime() + 60 * DAY_MS;
    verifyAndDecodeTransaction.mockImplementation(async () => {
      await prisma.subscription.update({
        where: { id: subId },
        data: { currentPeriodEnd: new Date(webhookExpiry) },
      });
      return decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: cronExpiry,
      });
    });

    const summary = await runEntitlementReconcile({ now: NOW });

    // The guard matched 0 rows → skipped, not refreshed.
    expect(summary.skipped).toBe(1);
    expect(summary.refreshed).toHaveLength(0);

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    // The fresher webhook window survives; the cron did NOT clobber it.
    expect(after.currentPeriodEnd.getTime()).toBe(webhookExpiry);
  });

  test("(11) expired-rescue: expired DB row now ACTIVE at provider → rescued + entitled", async () => {
    const accountId = await newAccount();
    // Row was written `expired` (expiration webhook landed); updatedAt recent.
    const oldEnd = new Date(NOW.getTime() - 1 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.expired,
      currentPeriodEnd: oldEnd,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    // Provider now reports ACTIVE with a fresh future window (the renewal/
    // recovery webhook was dropped).
    const newExpiry = NOW.getTime() + 30 * DAY_MS;
    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_ACTIVE,
        txJws: "jws-revived",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: newExpiry,
      }),
    );

    const summary = await runEntitlementReconcile({ now: NOW });

    expect(summary.scanned).toBe(1);
    expect(summary.refreshed).toHaveLength(1);
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.status).toBe(SubscriptionStatus.active);
    expect(after.currentPeriodEnd.getTime()).toBe(newExpiry);
    expect(isEntitledSubscription(after, NOW)).toBe(true);
  });

  test("(11b) expired-rescue is bounded: an old expired row is NOT scanned", async () => {
    const accountId = await newAccount();
    const oldEnd = new Date(NOW.getTime() - 40 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.expired,
      currentPeriodEnd: oldEnd,
    });
    // Force updatedAt to be well outside the 14-day rescue window.
    await prisma.subscription.update({
      where: { id: subId },
      data: { updatedAt: new Date(NOW.getTime() - 40 * DAY_MS) },
    });

    const summary = await runEntitlementReconcile({ now: NOW });

    // Out of both the entitled at-risk set and the bounded rescue window.
    expect(summary.scanned).toBe(0);
    expect(getSubscriptionStatuses).not.toHaveBeenCalled();
  });

  test("(11c) S-N4 rescue must NOT revive on a stale local window", async () => {
    const accountId = await newAccount();
    // Expired DB row carrying a FABRICATED future local window (a stale value a
    // dropped/mis-ordered webhook could have left). updatedAt recent → in the
    // rescue scan.
    const fabricatedFuture = new Date(NOW.getTime() + 20 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.expired,
      currentPeriodEnd: fabricatedFuture,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    // Provider truth: ACTIVE again, but with an OLDER (real) window than the
    // stale local one.
    const realActiveEnd = NOW.getTime() + 5 * DAY_MS;
    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_ACTIVE,
        txJws: "jws-rescue-older",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: realActiveEnd,
      }),
    );

    await runEntitlementReconcile({ now: NOW });

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    // The provider window WINS (rescue), even though it regresses the stale
    // local one — the row never carries an active-status-with-fabricated-window
    // combination.
    expect(after.status).toBe(SubscriptionStatus.active);
    expect(after.currentPeriodEnd.getTime()).toBe(realActiveEnd);
    expect(after.currentPeriodEnd.getTime()).not.toBe(
      fabricatedFuture.getTime(),
    );
    // Entitlement is governed by the REAL provider window.
    expect(isEntitledSubscription(after, NOW)).toBe(true);
    const pastReal = new Date(realActiveEnd + 1 * DAY_MS);
    expect(isEntitledSubscription(after, pastReal)).toBe(false);
  });

  test("(11d) S-N4: refund/revoke at provider keeps an expired row expired (not revived)", async () => {
    const accountId = await newAccount();
    // Expired row with a fabricated future local window; provider confirms a
    // REVOKE (refund). This is NOT a rescue → must stay non-entitled, never
    // flip to active on the stale window.
    const fabricatedFuture = new Date(NOW.getTime() + 20 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.expired,
      currentPeriodEnd: fabricatedFuture,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_REVOKED,
        txJws: "jws-refunded",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: fabricatedFuture.getTime(),
        revocationDate: NOW.getTime() - 1 * DAY_MS,
      }),
    );

    await runEntitlementReconcile({ now: NOW });

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.status).toBe(SubscriptionStatus.revoked);
    expect(isEntitledSubscription(after, NOW)).toBe(false);
  });

  test("(11e) R3-N1 grace-rescue: expired row with a stale PAST gracePeriodEnd → status=4 grace rescues to the provider deadline (entitled)", async () => {
    const accountId = await newAccount();
    // Row was written `expired` (expiration webhook landed) and is carrying a
    // STALE PAST gracePeriodEnd from an earlier grace stint. updatedAt recent →
    // in the rescue scan.
    const lapsedEnd = new Date(NOW.getTime() - 2 * DAY_MS);
    const stalePastGrace = new Date(NOW.getTime() - 1 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.expired,
      currentPeriodEnd: lapsedEnd,
      gracePeriodEnd: stalePastGrace,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    // Provider now reports BILLING_GRACE again (status=4) with a FRESH FUTURE
    // grace deadline (a recovery/grace webhook was dropped).
    const newGraceDeadline = NOW.getTime() + 5 * DAY_MS;
    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_BILLING_GRACE,
        txJws: "jws-grace-rescue",
        renewalJws: "jws-renewal-grace-rescue",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: lapsedEnd.getTime(),
      }),
    );
    verifyAndDecodeRenewalInfo.mockResolvedValue({
      gracePeriodExpiresDate: newGraceDeadline,
    });

    const summary = await runEntitlementReconcile({ now: NOW });

    expect(summary.refreshed).toHaveLength(1);
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.status).toBe(SubscriptionStatus.grace);
    // R3-N1: the rescue bypasses the non-extending grace clamp — the provider's
    // FUTURE deadline WINS over the stale PAST local value, instead of
    // min(past, future) = past stranding the rescue as not-entitled.
    expect(after.gracePeriodEnd?.getTime()).toBe(newGraceDeadline);
    expect(after.gracePeriodEnd?.getTime()).not.toBe(stalePastGrace.getTime());
    // The entitlement VERDICT — the rescued row reads ENTITLED again...
    expect(isEntitledSubscription(after, NOW)).toBe(true);
    // ...and past the new deadline the SAME row reads expired.
    const pastNewDeadline = new Date(newGraceDeadline + 1 * DAY_MS);
    expect(isEntitledSubscription(after, pastNewDeadline)).toBe(false);
  });

  test("(12) batch with one failing sub → others still processed", async () => {
    const acctA = await newAccount();
    const acctB = await newAccount();
    const acctC = await newAccount();

    const subA = await seedAppleSub({
      accountId: acctA,
      currentPeriodEnd: new Date(NOW.getTime() + 1 * DAY_MS),
    });
    const subB = await seedAppleSub({
      accountId: acctB,
      currentPeriodEnd: new Date(NOW.getTime() + 1 * DAY_MS),
    });
    const subC = await seedGoogleSub({
      accountId: acctC,
      currentPeriodEnd: new Date(NOW.getTime() + 1 * DAY_MS),
    });

    const rowA = await prisma.subscription.findUniqueOrThrow({
      where: { id: subA },
    });
    const rowB = await prisma.subscription.findUniqueOrThrow({
      where: { id: subB },
    });

    const newExpiry = NOW.getTime() + 30 * DAY_MS;

    getSubscriptionStatuses.mockImplementation((id: string) => {
      if (id === rowA.originalTransactionId) {
        return Promise.reject(new Error("network reset"));
      }
      if (id === rowB.originalTransactionId) {
        return Promise.resolve(
          appleStatusResponse(id, {
            status: APPLE_STATUS_ACTIVE,
            txJws: "jws-b",
          }),
        );
      }
      return Promise.resolve({ data: [] });
    });
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: rowB.originalTransactionId ?? "",
        expiresDate: newExpiry,
      }),
    );
    fetchSubscriptionPurchaseV2.mockResolvedValue({
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      startTime: new Date(newExpiry - 30 * DAY_MS).toISOString(),
      latestOrderId: "GPA.test-1",
      lineItems: [
        {
          productId: "app.convos.subs.monthly",
          expiryTime: new Date(newExpiry).toISOString(),
          autoRenewingPlan: { autoRenewEnabled: true },
        },
      ],
    });

    const summary = await runEntitlementReconcile({ now: NOW });

    expect(summary.scanned).toBe(3);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].subscriptionId).toBe(subA);
    expect(summary.refreshed.map((r) => r.subscriptionId).sort()).toEqual(
      [subB, subC].sort(),
    );

    const afterA = await prisma.subscription.findUniqueOrThrow({
      where: { id: subA },
    });
    const afterB = await prisma.subscription.findUniqueOrThrow({
      where: { id: subB },
    });
    const afterC = await prisma.subscription.findUniqueOrThrow({
      where: { id: subC },
    });
    expect(afterA.currentPeriodEnd.getTime()).toBe(
      rowA.currentPeriodEnd.getTime(),
    );
    expect(afterB.currentPeriodEnd.getTime()).toBe(newExpiry);
    expect(afterC.currentPeriodEnd.getTime()).toBe(newExpiry);
  });

  test("(13) ambiguous Apple response (no matching transaction) → fail-safe, errored, unchanged", async () => {
    const accountId = await newAccount();
    const staleEnd = new Date(NOW.getTime() + 1 * DAY_MS);
    const subId = await seedAppleSub({ accountId, currentPeriodEnd: staleEnd });

    getSubscriptionStatuses.mockResolvedValue({ data: [] });

    const summary = await runEntitlementReconcile({ now: NOW });

    expect(summary.errors).toHaveLength(1);
    expect(summary.refreshed).toHaveLength(0);
    expect(verifyAndDecodeTransaction).not.toHaveBeenCalled();

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.currentPeriodEnd.getTime()).toBe(staleEnd.getTime());
  });

  test("(13b) N-N3: Apple match keys on THIS sub's originalTransactionId, not the first item", async () => {
    const accountId = await newAccount();
    const staleEnd = new Date(NOW.getTime() + 1 * DAY_MS);
    const subId = await seedAppleSub({ accountId, currentPeriodEnd: staleEnd });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    const otx = sub.originalTransactionId ?? "";

    // The group's first item belongs to a DIFFERENT original transaction
    // (another product line). The matcher must skip it and pick ours.
    const newExpiry = NOW.getTime() + 30 * DAY_MS;
    getSubscriptionStatuses.mockResolvedValue({
      data: [
        {
          lastTransactions: [
            {
              originalTransactionId: `other-${randomUUID()}`,
              status: APPLE_STATUS_EXPIRED,
              signedTransactionInfo: "jws-other",
            },
            {
              originalTransactionId: otx,
              status: APPLE_STATUS_ACTIVE,
              signedTransactionInfo: "jws-ours",
            },
          ],
        },
      ],
    });
    verifyAndDecodeTransaction.mockImplementation((jws: string) => {
      // Guard: only OUR jws should be decoded.
      expect(jws).toBe("jws-ours");
      return Promise.resolve(
        decodedTransaction({
          originalTransactionId: otx,
          expiresDate: newExpiry,
        }),
      );
    });

    const summary = await runEntitlementReconcile({ now: NOW });

    expect(summary.refreshed).toHaveLength(1);
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    // Resolved to OUR active line, not the other product's expired one.
    expect(after.status).toBe(SubscriptionStatus.active);
    expect(after.currentPeriodEnd.getTime()).toBe(newExpiry);
    expect(isEntitledSubscription(after, NOW)).toBe(true);
  });

  test("(14) Google provider throws → fail-safe, errored, unchanged", async () => {
    const accountId = await newAccount();
    const staleEnd = new Date(NOW.getTime() + 1 * DAY_MS);
    const subId = await seedGoogleSub({
      accountId,
      currentPeriodEnd: staleEnd,
    });

    fetchSubscriptionPurchaseV2.mockRejectedValue(new Error("429 rate limit"));

    const summary = await runEntitlementReconcile({ now: NOW });

    expect(summary.errors).toHaveLength(1);
    expect(summary.refreshed).toHaveLength(0);
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    expect(after.currentPeriodEnd.getTime()).toBe(staleEnd.getTime());
    expect(after.status).toBe(SubscriptionStatus.active);
  });

  test("(15) grace deadline non-extending clamp: provider grace > existing deadline → not extended", async () => {
    const accountId = await newAccount();
    const lapsedEnd = new Date(NOW.getTime() - 1 * DAY_MS);
    // Already in grace with a near deadline.
    const existingDeadline = new Date(NOW.getTime() + 2 * DAY_MS);
    const subId = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.grace,
      currentPeriodEnd: lapsedEnd,
      gracePeriodEnd: existingDeadline,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });

    // Provider reports a LATER grace deadline (would extend free access).
    const laterDeadline = NOW.getTime() + 10 * DAY_MS;
    getSubscriptionStatuses.mockResolvedValue(
      appleStatusResponse(sub.originalTransactionId ?? "", {
        status: APPLE_STATUS_BILLING_GRACE,
        txJws: "jws-grace2",
        renewalJws: "jws-renewal-grace2",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: sub.originalTransactionId ?? "",
        expiresDate: lapsedEnd.getTime(),
      }),
    );
    verifyAndDecodeRenewalInfo.mockResolvedValue({
      gracePeriodExpiresDate: laterDeadline,
    });

    const summary = await runEntitlementReconcile({ now: NOW });

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
    });
    // Clamp held: deadline NOT extended past the existing one.
    expect(after.gracePeriodEnd?.getTime()).toBe(existingDeadline.getTime());
    // Already grace + same (clamped) deadline + same window → no-op.
    expect(summary.refreshed).toHaveLength(0);
    expect(summary.noOp).toBe(1);
  });
});
