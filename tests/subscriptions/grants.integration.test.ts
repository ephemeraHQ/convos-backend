import { randomUUID } from "node:crypto";
import {
  AppleEnv,
  BillingProvider,
  LedgerReason,
  SubscriptionPeriod,
  SubscriptionStatus,
} from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import { consume, getBalance, grant } from "@/payments";
import { subForfeitKey, subGrantKey } from "@/subscriptions/grants";
import {
  applyNotification,
  SUBSCRIPTION_TIER_PLUS,
  upsertFromVerify,
} from "@/subscriptions/repository";
import { tierGrant } from "@/subscriptions/tier-config";
import { prisma } from "@/utils/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;
const perPeriod = () =>
  tierGrant(SUBSCRIPTION_TIER_PLUS, SubscriptionPeriod.monthly).perPeriod;

const created: string[] = [];
afterEach(async () => {
  if (created.length === 0) return;
  await prisma.billingReceipt.deleteMany({
    where: { subscription: { accountId: { in: created } } },
  });
  await prisma.subscription.deleteMany({
    where: { accountId: { in: created } },
  });
  await prisma.creditLedger.deleteMany({
    where: { accountId: { in: created } },
  });
  await prisma.userCredits.deleteMany({
    where: { accountId: { in: created } },
  });
  await prisma.account.deleteMany({ where: { id: { in: created } } });
  created.length = 0;
});

const newAccount = async (): Promise<string> => {
  const acct = await prisma.account.create({ data: {} });
  created.push(acct.id);
  return acct.id;
};

const verifyApple = async (
  accountId: string,
  overrides: {
    originalTransactionId?: string;
    transactionId?: string;
    status?: SubscriptionStatus;
    currentPeriodStart?: Date;
    currentPeriodEnd?: Date;
  } = {},
) => {
  const start =
    overrides.currentPeriodStart ?? new Date(Date.now() - 5 * DAY_MS);
  const end = overrides.currentPeriodEnd ?? new Date(Date.now() + 25 * DAY_MS);
  return upsertFromVerify({
    provider: BillingProvider.apple,
    accountId,
    appAccountToken: randomUUID(),
    productId: "app.convos.subs.monthly",
    tier: SUBSCRIPTION_TIER_PLUS,
    period: SubscriptionPeriod.monthly,
    status: overrides.status ?? SubscriptionStatus.active,
    originalTransactionId:
      overrides.originalTransactionId ?? `otid-${accountId}`,
    transactionId: overrides.transactionId ?? `tx-${randomUUID()}`,
    startedAt: start,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    willRenew: true,
    isInTrial: false,
    environment: AppleEnv.sandbox,
    signedPayload: "stub.jws",
  });
};

describe("subscription grant materialization (single-ledger)", () => {
  it("verify writes one real sub_grant row and credits the wallet", async () => {
    const accountId = await newAccount();
    const { subscription } = await verifyApple(accountId);

    expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));

    const key = subGrantKey(subscription.id, subscription.currentPeriodStart);
    const row = await prisma.creditLedger.findUnique({
      where: { accountId_idempotencyKey: { accountId, idempotencyKey: key } },
    });
    expect(row?.reason).toBe(LedgerReason.grant);
    expect(row?.grantKindId).toBe("sub_grant");
    expect(row?.delta).toBe(BigInt(perPeriod()));

    const fresh = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(fresh?.lastGrantedPeriodStart?.toISOString()).toBe(
      subscription.currentPeriodStart.toISOString(),
    );
  });

  it("re-verify of the same period is idempotent — no double grant", async () => {
    const accountId = await newAccount();
    const otid = `otid-${accountId}`;
    await verifyApple(accountId, { originalTransactionId: otid });
    // Same period, different provider transactionId (e.g. a re-verify).
    await verifyApple(accountId, {
      originalTransactionId: otid,
      transactionId: `tx-${randomUUID()}`,
    });

    expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));
    const grantRows = await prisma.creditLedger.count({
      where: { accountId, grantKindId: "sub_grant" },
    });
    expect(grantRows).toBe(1);
  });

  it("renewal advancing the period grants the new period again", async () => {
    const accountId = await newAccount();
    const otid = `otid-${accountId}`;
    const { subscription } = await verifyApple(accountId, {
      originalTransactionId: otid,
    });
    expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));

    const newStart = new Date(Date.now() + 25 * DAY_MS);
    const newEnd = new Date(newStart.getTime() + 30 * DAY_MS);
    const res = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otid,
      transactionId: `tx-renew-${randomUUID()}`,
      notificationUUID: randomUUID(),
      notificationType: "DID_RENEW",
      signedPayload: "stub.jws",
      update: {
        status: SubscriptionStatus.active,
        currentPeriodStart: newStart,
        currentPeriodEnd: newEnd,
        willRenew: true,
      },
    });
    expect(res.kind).toBe("applied");

    // Two periods granted → wallet holds 2 × perPeriod.
    expect(await getBalance(accountId)).toBe(BigInt(perPeriod() * 2));
    const grantRows = await prisma.creditLedger.count({
      where: { accountId, grantKindId: "sub_grant" },
    });
    expect(grantRows).toBe(2);

    const fresh = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(fresh?.lastGrantedPeriodStart?.toISOString()).toBe(
      newStart.toISOString(),
    );
  });
});

describe("subscription forfeit (bounded clawback)", () => {
  it("expiry forfeits only the unused subscription portion; admin credits survive", async () => {
    const accountId = await newAccount();
    const otid = `otid-${accountId}`;
    const { subscription } = await verifyApple(accountId, {
      originalTransactionId: otid,
    });
    // Admin/manual credits on top of the subscription grant.
    await grant({
      accountId,
      credits: 1000,
      kind: "manual",
      idempotencyKey: `admin-${randomUUID()}`,
    });
    // Spend part of the period (real wallet decrement).
    const spend = await consume({
      accountId,
      usdCostMicros: 50_000n, // 100 credits
      idempotencyKey: `c-${randomUUID()}`,
      requestId: "r",
    });

    const balanceBeforeExpiry = await getBalance(accountId);
    expect(balanceBeforeExpiry).toBe(
      BigInt(perPeriod()) + 1000n - BigInt(spend.spent),
    );

    const res = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otid,
      transactionId: `tx-exp-${randomUUID()}`,
      notificationUUID: randomUUID(),
      notificationType: "EXPIRED",
      signedPayload: "stub.jws",
      update: {
        status: SubscriptionStatus.expired,
        willRenew: false,
        gracePeriodEnd: null,
      },
    });
    expect(res.kind).toBe("applied");

    // unusedSub = perPeriod - spent; forfeit removes exactly that, leaving the
    // 1000 admin credits intact.
    const unusedSub = perPeriod() - spend.spent;
    expect(await getBalance(accountId)).toBe(
      balanceBeforeExpiry - BigInt(unusedSub),
    );
    expect(await getBalance(accountId)).toBe(1000n);

    const forfeitKey = subForfeitKey(
      subscription.id,
      subscription.currentPeriodStart,
    );
    const forfeitRow = await prisma.creditLedger.findUnique({
      where: {
        accountId_idempotencyKey: { accountId, idempotencyKey: forfeitKey },
      },
    });
    expect(forfeitRow?.grantKindId).toBe("subscription_forfeit");
    expect(forfeitRow?.delta).toBe(BigInt(-unusedSub));
  });

  it("forfeit is clamped at the wallet balance — never goes below 0", async () => {
    const accountId = await newAccount();
    const otid = `otid-${accountId}`;
    await verifyApple(accountId, { originalTransactionId: otid });
    // Drain almost the whole wallet so unusedSub > walletBalance at expiry.
    await consume({
      accountId,
      usdCostMicros: BigInt((perPeriod() - 50) * 500), // leaves 50 in wallet
      idempotencyKey: `c-${randomUUID()}`,
      requestId: "r",
    });
    expect(await getBalance(accountId)).toBe(50n);

    await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otid,
      transactionId: `tx-exp-${randomUUID()}`,
      notificationUUID: randomUUID(),
      notificationType: "EXPIRED",
      signedPayload: "stub.jws",
      update: {
        status: SubscriptionStatus.expired,
        willRenew: false,
      },
    });

    // unusedSub (perPeriod - 50) > walletBalance (50), so forfeit = -50 → 0.
    expect(await getBalance(accountId)).toBe(0n);
  });

  it("duplicate expiry webhook does not double-claw (idempotent forfeit)", async () => {
    const accountId = await newAccount();
    const otid = `otid-${accountId}`;
    await verifyApple(accountId, { originalTransactionId: otid });
    await grant({
      accountId,
      credits: 1000,
      kind: "manual",
      idempotencyKey: `admin-${randomUUID()}`,
    });

    const expire = () =>
      applyNotification({
        provider: BillingProvider.apple,
        originalTransactionId: otid,
        transactionId: `tx-exp-${randomUUID()}`,
        notificationUUID: randomUUID(),
        notificationType: "EXPIRED",
        signedPayload: "stub.jws",
        update: { status: SubscriptionStatus.expired, willRenew: false },
      });

    await expire();
    const afterFirst = await getBalance(accountId);
    await expire(); // second EXPIRED for the same period
    expect(await getBalance(accountId)).toBe(afterFirst);
    expect(afterFirst).toBe(1000n);

    const forfeitRows = await prisma.creditLedger.count({
      where: { accountId, grantKindId: "subscription_forfeit" },
    });
    expect(forfeitRows).toBe(1);
  });

  it("refund (REVOKE) immediately forfeits the unused portion", async () => {
    const accountId = await newAccount();
    const otid = `otid-${accountId}`;
    await verifyApple(accountId, { originalTransactionId: otid });
    expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));

    await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otid,
      transactionId: `tx-rev-${randomUUID()}`,
      notificationUUID: randomUUID(),
      notificationType: "REVOKE",
      signedPayload: "stub.jws",
      update: {
        status: SubscriptionStatus.revoked,
        willRenew: false,
        cancelledAt: new Date(),
      },
    });
    // Nothing consumed → whole period forfeited.
    expect(await getBalance(accountId)).toBe(0n);
  });

  it("cancel-while-active (auto-renew off, period running) does NOT forfeit", async () => {
    const accountId = await newAccount();
    const otid = `otid-${accountId}`;
    await verifyApple(accountId, { originalTransactionId: otid });
    expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));

    await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otid,
      transactionId: `tx-cancel-${randomUUID()}`,
      notificationUUID: randomUUID(),
      notificationType: "DID_CHANGE_RENEWAL_STATUS",
      signedPayload: "stub.jws",
      update: { willRenew: false },
    });
    // Status stays active → credits stay to the period end.
    expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));
    const forfeitRows = await prisma.creditLedger.count({
      where: { accountId, grantKindId: "subscription_forfeit" },
    });
    expect(forfeitRows).toBe(0);
  });
});
