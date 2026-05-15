import { afterEach, describe, expect, test } from "bun:test";
import {
  applyNotification,
  findByOriginalTransactionId,
  findCurrentByAccountId,
  findReceiptByTransactionId,
  serializeUserSubscription,
  SubscriptionPeriod,
  SubscriptionStatus,
  SubscriptionTier,
  upsertFromVerify,
  type VerifyInput,
} from "@/subscriptions/repository";
import { prisma } from "@/utils/prisma";

const makeAccount = async () => {
  const account = await prisma.account.create({ data: {} });
  return account.id;
};

const makeAccountIds: string[] = [];

const newAccount = async () => {
  const id = await makeAccount();
  makeAccountIds.push(id);
  return id;
};

const fixedDates = {
  startedAt: new Date("2026-05-01T00:00:00.000Z"),
  currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
};

const verifyInput = (overrides: Partial<VerifyInput>): VerifyInput => ({
  accountId: overrides.accountId ?? "",
  appAccountToken:
    overrides.appAccountToken ?? "11111111-2222-3333-4444-555555555555",
  productId: overrides.productId ?? "app.convos.subs.builder.monthly",
  tier: overrides.tier ?? SubscriptionTier.builder,
  period: overrides.period ?? SubscriptionPeriod.monthly,
  status: overrides.status ?? SubscriptionStatus.active,
  originalTransactionId:
    overrides.originalTransactionId ?? `otid_${Date.now()}_${Math.random()}`,
  transactionId:
    overrides.transactionId ?? `txid_${Date.now()}_${Math.random()}`,
  startedAt: overrides.startedAt ?? fixedDates.startedAt,
  currentPeriodStart:
    overrides.currentPeriodStart ?? fixedDates.currentPeriodStart,
  currentPeriodEnd: overrides.currentPeriodEnd ?? fixedDates.currentPeriodEnd,
  willRenew: overrides.willRenew ?? true,
  isInTrial: overrides.isInTrial ?? false,
  environment: overrides.environment ?? "sandbox",
  signedPayload: overrides.signedPayload ?? "stub.jws.payload",
});

const wipeForAccounts = async (accountIds: string[]) => {
  if (accountIds.length === 0) return;
  await prisma.appleReceipt.deleteMany({
    where: { subscription: { accountId: { in: accountIds } } },
  });
  await prisma.subscription.deleteMany({
    where: { accountId: { in: accountIds } },
  });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
};

afterEach(async () => {
  await wipeForAccounts(makeAccountIds);
  makeAccountIds.length = 0;
});

describe("upsertFromVerify", () => {
  test("creates a new subscription on first verify", async () => {
    const accountId = await newAccount();
    const { subscription, receiptCreated } = await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: "otid-1",
        transactionId: "tx-1",
      }),
    );
    expect(subscription.accountId).toBe(accountId);
    expect(subscription.tier).toBe(SubscriptionTier.builder);
    expect(subscription.status).toBe(SubscriptionStatus.active);
    expect(receiptCreated).toBe(true);

    const receipt = await findReceiptByTransactionId("tx-1");
    expect(receipt).not.toBeNull();
    expect(receipt?.subscriptionId).toBe(subscription.id);
    expect(receipt?.notificationType).toBe("VERIFY");
  });

  test("replay of same transactionId is idempotent (no duplicate receipt)", async () => {
    const accountId = await newAccount();
    const input = verifyInput({
      accountId,
      originalTransactionId: "otid-2",
      transactionId: "tx-2",
    });
    const first = await upsertFromVerify(input);
    const second = await upsertFromVerify(input);

    expect(first.receiptCreated).toBe(true);
    expect(second.receiptCreated).toBe(false);
    expect(second.subscription.id).toBe(first.subscription.id);

    const receipts = await prisma.appleReceipt.findMany({
      where: { transactionId: "tx-2" },
    });
    expect(receipts).toHaveLength(1);
  });

  test("renewal (new transactionId, same originalTransactionId) updates state + records second receipt", async () => {
    const accountId = await newAccount();
    const otid = "otid-3";
    const first = await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: otid,
        transactionId: "tx-3a",
        currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );

    const renewed = await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: otid,
        transactionId: "tx-3b",
        currentPeriodEnd: new Date("2026-07-01T00:00:00.000Z"),
      }),
    );

    expect(renewed.subscription.id).toBe(first.subscription.id);
    expect(renewed.subscription.currentPeriodEnd.toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(renewed.receiptCreated).toBe(true);

    const receipts = await prisma.appleReceipt.findMany({
      where: { subscriptionId: first.subscription.id },
      orderBy: { receivedAt: "asc" },
    });
    expect(receipts).toHaveLength(2);
    expect(receipts.map((r) => r.transactionId)).toEqual(["tx-3a", "tx-3b"]);
  });

  test("cross-device transfer: same originalTransactionId, new accountId + appAccountToken reassigns", async () => {
    const accountA = await newAccount();
    const accountB = await newAccount();
    const otid = "otid-transfer";

    await upsertFromVerify(
      verifyInput({
        accountId: accountA,
        appAccountToken: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        originalTransactionId: otid,
        transactionId: "tx-transfer-a",
      }),
    );

    const transferred = await upsertFromVerify(
      verifyInput({
        accountId: accountB,
        appAccountToken: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        originalTransactionId: otid,
        transactionId: "tx-transfer-b",
      }),
    );

    expect(transferred.subscription.accountId).toBe(accountB);
    expect(transferred.subscription.appAccountToken).toBe(
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );

    // Account A no longer "owns" the sub.
    expect(await findCurrentByAccountId(accountA)).toBeNull();
    const forB = await findCurrentByAccountId(accountB);
    expect(forB?.id).toBe(transferred.subscription.id);
  });
});

describe("findCurrentByAccountId", () => {
  test("returns null when account has no subscription", async () => {
    const accountId = await newAccount();
    expect(await findCurrentByAccountId(accountId)).toBeNull();
  });

  test("prefers an active sub over an expired one", async () => {
    const accountId = await newAccount();
    await upsertFromVerify(
      verifyInput({
        accountId,
        appAccountToken: "11111111-1111-1111-1111-111111111111",
        originalTransactionId: "otid-expired",
        transactionId: "tx-expired",
        status: SubscriptionStatus.expired,
      }),
    );
    const active = await upsertFromVerify(
      verifyInput({
        accountId,
        appAccountToken: "22222222-2222-2222-2222-222222222222",
        originalTransactionId: "otid-active",
        transactionId: "tx-active",
        status: SubscriptionStatus.active,
      }),
    );
    const current = await findCurrentByAccountId(accountId);
    expect(current?.id).toBe(active.subscription.id);
  });

  test("falls back to most recent expired sub when no active exists", async () => {
    const accountId = await newAccount();
    await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: "otid-revoked",
        transactionId: "tx-revoked",
        status: SubscriptionStatus.revoked,
      }),
    );
    const current = await findCurrentByAccountId(accountId);
    expect(current).not.toBeNull();
    expect(current?.status).toBe(SubscriptionStatus.revoked);
  });
});

describe("applyNotification", () => {
  test("returns unknown_subscription when originalTransactionId has no row", async () => {
    const result = await applyNotification({
      originalTransactionId: "otid-missing",
      transactionId: "tx-missing",
      notificationType: "DID_RENEW",
      signedPayload: "stub",
      update: { status: SubscriptionStatus.active },
    });
    expect(result.kind).toBe("unknown_subscription");
  });

  test("applies status update and records audit receipt", async () => {
    const accountId = await newAccount();
    await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: "otid-apply",
        transactionId: "tx-apply-1",
      }),
    );

    const result = await applyNotification({
      originalTransactionId: "otid-apply",
      transactionId: "tx-apply-2",
      notificationType: "DID_FAIL_TO_RENEW",
      notificationSubtype: "GRACE_PERIOD",
      signedPayload: "stub-grace",
      update: {
        status: SubscriptionStatus.grace,
        gracePeriodEnd: new Date("2026-06-15T00:00:00.000Z"),
      },
    });

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.subscription.status).toBe(SubscriptionStatus.grace);
      expect(result.subscription.gracePeriodEnd?.toISOString()).toBe(
        "2026-06-15T00:00:00.000Z",
      );
    }

    const receipt = await findReceiptByTransactionId("tx-apply-2");
    expect(receipt?.notificationType).toBe("DID_FAIL_TO_RENEW");
    expect(receipt?.notificationSubtype).toBe("GRACE_PERIOD");
  });

  test("returns replayed when transactionId was already recorded — no double state apply", async () => {
    const accountId = await newAccount();
    await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: "otid-replay",
        transactionId: "tx-replay-initial",
      }),
    );

    const first = await applyNotification({
      originalTransactionId: "otid-replay",
      transactionId: "tx-replay-1",
      notificationType: "DID_RENEW",
      signedPayload: "stub",
      update: { status: SubscriptionStatus.active },
    });
    expect(first.kind).toBe("applied");

    // Same transactionId → replayed. The state update would have been a no-op
    // anyway, but the point is no second AppleReceipt row.
    const second = await applyNotification({
      originalTransactionId: "otid-replay",
      transactionId: "tx-replay-1",
      notificationType: "DID_RENEW",
      signedPayload: "stub",
      update: { status: SubscriptionStatus.expired },
    });
    expect(second.kind).toBe("replayed");
    if (second.kind === "replayed") {
      // Critically: status did NOT flip to expired.
      expect(second.subscription.status).toBe(SubscriptionStatus.active);
    }

    const receipts = await prisma.appleReceipt.findMany({
      where: { transactionId: "tx-replay-1" },
    });
    expect(receipts).toHaveLength(1);
  });
});

describe("findByOriginalTransactionId", () => {
  test("returns the matching subscription", async () => {
    const accountId = await newAccount();
    const { subscription } = await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: "otid-find",
        transactionId: "tx-find",
      }),
    );
    const found = await findByOriginalTransactionId("otid-find");
    expect(found?.id).toBe(subscription.id);
  });

  test("returns null when not found", async () => {
    expect(await findByOriginalTransactionId("nope")).toBeNull();
  });
});

describe("serializeUserSubscription", () => {
  test("produces the iOS UserSubscription shape", async () => {
    const accountId = await newAccount();
    const { subscription } = await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: "otid-serialize",
        transactionId: "tx-serialize",
        tier: SubscriptionTier.pro,
        period: SubscriptionPeriod.annual,
        status: SubscriptionStatus.trial,
        productId: "app.convos.subs.pro.annual",
        isInTrial: true,
        willRenew: true,
        currentPeriodEnd: new Date("2027-05-01T00:00:00.000Z"),
      }),
    );
    expect(serializeUserSubscription(subscription)).toEqual({
      tier: SubscriptionTier.pro,
      period: SubscriptionPeriod.annual,
      status: SubscriptionStatus.trial,
      productId: "app.convos.subs.pro.annual",
      currentPeriodEnd: "2027-05-01T00:00:00.000Z",
      willRenew: true,
      isInTrial: true,
    });
  });
});
