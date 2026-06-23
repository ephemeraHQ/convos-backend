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
import {
  forfeitSubscriptionPeriod,
  subForfeitKey,
  subGrantKey,
} from "@/subscriptions/grants";
import {
  applyNotification,
  SUBSCRIPTION_TIER_PLUS,
  upsertFromVerify,
} from "@/subscriptions/repository";
import { tierGrant } from "@/subscriptions/tier-config";
import { prisma } from "@/utils/prisma";
import { materializeSubscriptionWallets } from "../../dev/scripts/materializeSubscriptionWallets";

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

  // B1: the forfeit must compute its clamp from the LOCKED wallet balance, not
  // an unlocked snapshot, or a consume committing between the read and the apply
  // could overshoot the (now smaller) base and drive the wallet negative.
  it("B1: forfeit clamps to the LOCKED balance — wallet never goes negative when a consume commits first", async () => {
    const accountId = await newAccount();
    const otid = `otid-${accountId}`;
    const { subscription } = await verifyApple(accountId, {
      originalTransactionId: otid,
    });
    // Whole period unused so far → unusedSub == perPeriod.
    expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));

    // Reload the subscription so we forfeit against its real currentPeriodStart.
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });

    // Drive the forfeit directly, but commit a large consume INSIDE the tx after
    // the forfeit has taken its lock — emulating the race the old unlocked read
    // was vulnerable to. With the lock, the consume below blocks until the
    // forfeit tx commits, so the forfeit clamps against the balance it actually
    // mutates. (We approximate the interleaving by spending almost everything
    // first, then forfeiting: forfeit's locked re-read sees the post-spend
    // balance, not the stale perPeriod.)
    await consume({
      accountId,
      usdCostMicros: BigInt((perPeriod() - 30) * 500), // leaves 30 in wallet
      idempotencyKey: `c-${randomUUID()}`,
      requestId: "r",
    });
    expect(await getBalance(accountId)).toBe(30n);

    const result = await prisma.$transaction((tx) =>
      forfeitSubscriptionPeriod(tx, { subscription: sub }),
    );

    // unusedSub = perPeriod - (perPeriod - 30) = 30; lockedBalance = 30; so
    // forfeit clamps to 30 and the wallet lands exactly at 0 — never negative.
    expect(result.kind).toBe("forfeited");
    if (result.kind === "forfeited") {
      expect(result.credits).toBe(30);
    }
    expect(await getBalance(accountId)).toBe(0n);
  });

  // B1: a forfeit and a consume racing concurrently must serialize on the
  // UserCredits row lock and leave a consistent, non-negative wallet whose
  // balance equals the sum of every ledger delta. Repeated across many trials
  // to actually exercise the read-then-write window the old unlocked snapshot
  // left open (against the pre-fix code this loop reliably produced a negative
  // balance; with the lock it never does).
  it("B1: concurrent forfeit + consume never drives the wallet negative (stress loop)", async () => {
    const TRIALS = 40;
    for (let i = 0; i < TRIALS; i++) {
      const accountId = await newAccount();
      const otid = `otid-${accountId}`;
      const { subscription } = await verifyApple(accountId, {
        originalTransactionId: otid,
      });
      // Admin credits on top so a correct forfeit can never wipe them.
      await grant({
        accountId,
        credits: 200,
        kind: "manual",
        idempotencyKey: `admin-${randomUUID()}`,
      });
      const sub = await prisma.subscription.findUniqueOrThrow({
        where: { id: subscription.id },
      });

      // Fire the forfeit (in its own tx, the production wrapper) and a large
      // consume concurrently. The UserCredits row lock must serialize them so
      // the forfeit clamps against the balance it actually mutates.
      const forfeitP = prisma
        .$transaction((tx) =>
          forfeitSubscriptionPeriod(tx, { subscription: sub }),
        )
        .catch(() => null);
      const consumeP = consume({
        accountId,
        usdCostMicros: BigInt((perPeriod() - 50) * 500), // spend most of the sub
        idempotencyKey: `c-${randomUUID()}`,
        requestId: "r",
      }).catch(() => null); // a floor breach is acceptable; invariants asserted below

      await Promise.all([forfeitP, consumeP]);

      const finalBalance = await getBalance(accountId);
      // The core invariant the bug violated: the wallet never goes negative.
      expect(finalBalance).toBeGreaterThanOrEqual(0n);
      // And it always equals the exact sum of every committed ledger delta.
      const agg = await prisma.creditLedger.aggregate({
        where: { accountId },
        _sum: { delta: true },
      });
      expect(finalBalance).toBe(agg._sum.delta ?? 0n);
      // The forfeit adjustment is always a non-positive clawback.
      const forfeitRows = await prisma.creditLedger.findMany({
        where: { accountId, grantKindId: "subscription_forfeit" },
      });
      for (const row of forfeitRows) {
        expect(row.delta).toBeLessThanOrEqual(0n);
      }
    }
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

describe("B2: n=1 materialization writes the FULL perPeriod grant", () => {
  const PRE_MIGRATION_SPEND = 500;

  // Build the pre-migration world: an entitled subscription whose current period
  // has consumes but NO sub_grant row yet (the live path hadn't run). We get
  // there by verifying (which auto-grants), then deleting the auto-grant and
  // recording a "pre-migration" consume against the wallet.
  const setupPreMigrationSubscriber = async () => {
    const accountId = await newAccount();
    const otid = `otid-${accountId}`;
    const { subscription } = await verifyApple(accountId, {
      originalTransactionId: otid,
    });

    // Spend part of the period (a real wallet decrement), then strip the
    // auto-written sub_grant so the row looks un-materialized, leaving the wallet
    // at (perPeriod - spend) - the closest analog to a derived-credits world
    // mid-spend before the single-ledger cutover.
    await consume({
      accountId,
      usdCostMicros: BigInt(PRE_MIGRATION_SPEND * 500), // PRE_MIGRATION_SPEND credits
      idempotencyKey: `pre-${randomUUID()}`,
      requestId: "r",
    });
    const grantKey = subGrantKey(
      subscription.id,
      subscription.currentPeriodStart,
    );
    // Remove the auto-grant row AND its credits from the wallet to emulate
    // "this period was never materialized into the ledger".
    await prisma.creditLedger.delete({
      where: {
        accountId_idempotencyKey: { accountId, idempotencyKey: grantKey },
      },
    });
    await prisma.userCredits.update({
      where: { accountId },
      data: { balance: { decrement: BigInt(perPeriod()) } },
    });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { lastGrantedPeriodStart: null },
    });

    return { accountId, otid, subscription };
  };

  it("materializes the FULL perPeriod (not clamped); re-run is a no-op", async () => {
    const { accountId, subscription } = await setupPreMigrationSubscriber();
    const balanceBefore = await getBalance(accountId);

    const res = await materializeSubscriptionWallets(true);
    expect(res.granted).toBeGreaterThanOrEqual(1);

    // The materialized row is the FULL perPeriod, indistinguishable from a live
    // grant — NOT perPeriod - PRE_MIGRATION_SPEND.
    const grantKey = subGrantKey(
      subscription.id,
      subscription.currentPeriodStart,
    );
    const row = await prisma.creditLedger.findUnique({
      where: {
        accountId_idempotencyKey: { accountId, idempotencyKey: grantKey },
      },
    });
    expect(row?.grantKindId).toBe("sub_grant");
    expect(row?.delta).toBe(BigInt(perPeriod()));

    // Wallet got the full allotment on top of whatever was left.
    expect(await getBalance(accountId)).toBe(
      balanceBefore + BigInt(perPeriod()),
    );

    // Re-run: same idempotency key → no second grant, balance unchanged.
    const before = await getBalance(accountId);
    const rerun = await materializeSubscriptionWallets(true);
    expect(rerun.granted).toBe(0);
    expect(await getBalance(accountId)).toBe(before);
    const grantRows = await prisma.creditLedger.count({
      where: { accountId, grantKindId: "sub_grant" },
    });
    expect(grantRows).toBe(1);
  });

  it("forfeit after materialization claws the CORRECT amount (no double-subtract)", async () => {
    const { accountId, otid, subscription } =
      await setupPreMigrationSubscriber();
    await materializeSubscriptionWallets(true);

    const balanceAfterMaterialize = await getBalance(accountId);

    await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otid,
      transactionId: `tx-exp-${randomUUID()}`,
      notificationUUID: randomUUID(),
      notificationType: "EXPIRED",
      signedPayload: "stub.jws",
      update: { status: SubscriptionStatus.expired, willRenew: false },
    });

    // periodGrant = perPeriod (full), periodConsumes = PRE_MIGRATION_SPEND, so
    // unusedSub = perPeriod - PRE_MIGRATION_SPEND. The clamped-grant bug would
    // have netted PRE_MIGRATION_SPEND a SECOND time → under-forfeit by 500.
    const expectedForfeit = perPeriod() - PRE_MIGRATION_SPEND;
    const forfeitKey = subForfeitKey(
      subscription.id,
      subscription.currentPeriodStart,
    );
    const forfeitRow = await prisma.creditLedger.findUnique({
      where: {
        accountId_idempotencyKey: { accountId, idempotencyKey: forfeitKey },
      },
    });
    expect(forfeitRow?.delta).toBe(BigInt(-expectedForfeit));
    expect(await getBalance(accountId)).toBe(
      balanceAfterMaterialize - BigInt(expectedForfeit),
    );
  });
});
