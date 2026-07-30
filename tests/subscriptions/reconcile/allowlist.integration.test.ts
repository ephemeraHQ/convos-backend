import { randomUUID } from "node:crypto";
import {
  BillingProvider,
  SubscriptionStatus,
  type Subscription,
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { subForfeitKey, subGrantKey } from "@/subscriptions/grants";
import { runAppleAllowlistReconcile } from "@/subscriptions/reconcile/service";
import { isEntitledSubscription } from "@/subscriptions/status";
import { tierGrant } from "@/subscriptions/tier-config";
import { prisma } from "@/utils/prisma";

// MOCK the provider boundary. Apple's status fetch + the JWS verifiers are
// stubbed so no real App Store Server API call is made; the environment
// fallback itself has its own dedicated test
// (tests/subscriptions/apple-server-api-env-fallback.test.ts).
const getSubscriptionStatusesWithEnvironmentFallback =
  vi.fn<(id: string, opts?: unknown) => Promise<unknown>>();
vi.mock("@/subscriptions/apple-server-api", () => ({
  getSubscriptionStatusesWithEnvironmentFallback: (
    id: string,
    opts?: unknown,
  ) => getSubscriptionStatusesWithEnvironmentFallback(id, opts),
}));

const verifyAndDecodeTransaction = vi.fn<(jws: string) => Promise<unknown>>();
const verifyAndDecodeRenewalInfo = vi.fn<(jws: string) => Promise<unknown>>();
vi.mock("@/subscriptions/jws-verifier", () => ({
  verifyAndDecodeTransaction: (jws: string) => verifyAndDecodeTransaction(jws),
  verifyAndDecodeRenewalInfo: (jws: string) => verifyAndDecodeRenewalInfo(jws),
}));

// Apple status enum (mirrors @apple/app-store-server-library Status).
const APPLE_STATUS_ACTIVE = 1;
const APPLE_STATUS_EXPIRED = 2;
const APPLE_STATUS_BILLING_RETRY = 3;
const APPLE_STATUS_BILLING_GRACE = 4;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 6, 29, 12, 0, 0));

const monthlyCredits = () => tierGrant("plus", "monthly").perPeriod;

const tracker: string[] = [];

const newAccount = async (): Promise<string> => {
  const acct = await prisma.account.create({ data: {} });
  tracker.push(acct.id);
  return acct.id;
};

const seedAppleSub = async (opts: {
  accountId: string;
  status?: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}) => {
  return prisma.subscription.create({
    data: {
      accountId: opts.accountId,
      provider: BillingProvider.apple,
      productId: "app.convos.subs.monthly",
      tier: "plus",
      period: "monthly",
      status: opts.status ?? SubscriptionStatus.active,
      originalTransactionId: `otx-${randomUUID()}`,
      appAccountToken: randomUUID(),
      startedAt: opts.currentPeriodStart,
      currentPeriodStart: opts.currentPeriodStart,
      currentPeriodEnd: opts.currentPeriodEnd,
      willRenew: true,
      isInTrial: false,
      environment: "sandbox",
    },
  });
};

const appleStatusResponse = (
  originalTransactionId: string,
  opts: { status: number; txJws?: string; renewalJws?: string },
) => ({
  environment: "Production",
  response: {
    data: [
      {
        lastTransactions: [
          {
            originalTransactionId,
            status: opts.status,
            signedTransactionInfo: opts.txJws ?? "jws-tx",
            ...(opts.renewalJws ? { signedRenewalInfo: opts.renewalJws } : {}),
          },
        ],
      },
    ],
  },
});

const decodedTransaction = (opts: {
  originalTransactionId: string;
  expiresDate: number;
  purchaseDate?: number;
  productId?: string;
}) => ({
  originalTransactionId: opts.originalTransactionId,
  transactionId: `tx-${randomUUID()}`,
  productId: opts.productId ?? "app.convos.subs.monthly",
  purchaseDate: opts.purchaseDate ?? opts.expiresDate - 30 * DAY_MS,
  expiresDate: opts.expiresDate,
});

const seedGrantForPeriod = async (sub: Subscription, periodStart: Date) => {
  await prisma.$transaction(async (tx) => {
    const { grantSubscriptionPeriod } = await import("@/subscriptions/grants");
    await grantSubscriptionPeriod(tx, { subscription: sub, periodStart });
  });
};

const ledgerRows = (accountId: string) =>
  prisma.creditLedger.findMany({ where: { accountId } });

const auditRows = (accountId: string) =>
  prisma.adminAudit.findMany({ where: { accountId } });

beforeEach(() => {
  getSubscriptionStatusesWithEnvironmentFallback.mockReset();
  verifyAndDecodeTransaction.mockReset();
  verifyAndDecodeRenewalInfo.mockReset();
});

afterEach(async () => {
  if (tracker.length === 0) return;
  await prisma.billingReceipt.deleteMany({
    where: { subscription: { accountId: { in: tracker } } },
  });
  await prisma.subscription.deleteMany({
    where: { accountId: { in: tracker } },
  });
  await prisma.adminAudit.deleteMany({
    where: { accountId: { in: tracker } },
  });
  await prisma.creditLedger.deleteMany({
    where: { accountId: { in: tracker } },
  });
  await prisma.userCredits.deleteMany({
    where: { accountId: { in: tracker } },
  });
  await prisma.account.deleteMany({ where: { id: { in: tracker } } });
  tracker.length = 0;
});

describe("runAppleAllowlistReconcile", () => {
  test("expired-never-granted (the pilot shape): status flips, ZERO ledger movement", async () => {
    const accountId = await newAccount();
    // Stale drift row: DB says active, but the period ended 40 days ago and
    // no sub_grant was ever written (pre-S2S era).
    const sub = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodStart: new Date(NOW.getTime() - 70 * DAY_MS),
      currentPeriodEnd: new Date(NOW.getTime() - 40 * DAY_MS),
    });
    const otx = sub.originalTransactionId ?? "";

    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otx, { status: APPLE_STATUS_EXPIRED }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otx,
        expiresDate: NOW.getTime() - 40 * DAY_MS,
      }),
    );

    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });

    expect(summary.mode).toBe("apply");
    expect(summary.results).toHaveLength(1);
    const result = summary.results[0];
    expect(result.outcome).toBe("applied");
    expect(result.after?.status).toBe(SubscriptionStatus.expired);

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after.status).toBe(SubscriptionStatus.expired);
    expect(after.willRenew).toBe(false);

    // The forfeit of a never-granted period MUST no-op (grants.ts
    // `skipped_nothing_to_forfeit`): zero ledger writes, no wallet created.
    expect(result.money.forfeit?.priorGrantExists).toBe(false);
    expect(result.money.forfeit?.result).toBe("skipped_nothing_to_forfeit");
    expect(result.money.grant).toBeUndefined();
    expect(await ledgerRows(accountId)).toHaveLength(0);
    expect(
      await prisma.userCredits.findUnique({ where: { accountId } }),
    ).toBeNull();

    // Audit trail: one reconcile row, zero credit delta.
    const audits = await auditRows(accountId);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("reconcile");
    expect(audits[0].deltaCredits).toBe(0n);

    // Re-run: already reconciled → noop, still zero ledger, no new audit row.
    const again = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });
    expect(again.results[0].outcome).toBe("noop");
    expect(await ledgerRows(accountId)).toHaveLength(0);
    expect(await auditRows(accountId)).toHaveLength(1);
  });

  test("entitled row with missing current-period grant: materialized via the idempotent helper", async () => {
    const accountId = await newAccount();
    const periodStart = new Date(NOW.getTime() - 5 * DAY_MS);
    const periodEnd = new Date(NOW.getTime() + 25 * DAY_MS);
    const sub = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });
    const otx = sub.originalTransactionId ?? "";

    // Provider agrees with the row state — the drift is purely the missing
    // sub_grant for the live period. Auto-renew is OFF (cancelled-but-active):
    // willRenew must come from the renewal info, not be assumed true.
    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otx, {
        status: APPLE_STATUS_ACTIVE,
        renewalJws: "jws-renewal",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otx,
        expiresDate: periodEnd.getTime(),
        purchaseDate: periodStart.getTime(),
      }),
    );
    verifyAndDecodeRenewalInfo.mockResolvedValue({ autoRenewStatus: 0 });

    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });

    const result = summary.results[0];
    expect(result.outcome).toBe("applied");
    expect(result.money.grant?.result).toBe("granted");
    expect(result.money.grant?.credits).toBe(monthlyCredits());
    const afterRow = await prisma.subscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(afterRow.willRenew).toBe(false);
    expect(result.money.forfeit).toBeUndefined();

    const rows = await ledgerRows(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(subGrantKey(sub.id, periodStart));
    expect(rows[0].delta).toBe(BigInt(monthlyCredits()));
    const wallet = await prisma.userCredits.findUniqueOrThrow({
      where: { accountId },
    });
    expect(wallet.balance).toBe(BigInt(monthlyCredits()));

    // Idempotent: a second apply run replays to a no-op — no double grant.
    const again = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });
    expect(again.results[0].outcome).toBe("noop");
    expect(await ledgerRows(accountId)).toHaveLength(1);
  });

  test("missed renewal: window advances, old period forfeited + new period granted through the helpers", async () => {
    const accountId = await newAccount();
    const oldStart = new Date(NOW.getTime() - 35 * DAY_MS);
    const oldEnd = new Date(NOW.getTime() - 5 * DAY_MS);
    const sub = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodStart: oldStart,
      currentPeriodEnd: oldEnd,
    });
    const otx = sub.originalTransactionId ?? "";

    // The old period WAS granted (normal verify flow) and never consumed.
    await seedGrantForPeriod(sub, oldStart);

    // Provider truth: a renewal we never heard about (no SSN feed).
    const newStart = oldEnd;
    const newEnd = new Date(oldEnd.getTime() + 30 * DAY_MS);
    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otx, { status: APPLE_STATUS_ACTIVE }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otx,
        expiresDate: newEnd.getTime(),
        purchaseDate: newStart.getTime(),
      }),
    );

    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });

    const result = summary.results[0];
    expect(result.outcome).toBe("applied");
    expect(result.after?.currentPeriodEnd).toBe(newEnd.toISOString());
    expect(result.money.forfeit?.result).toBe("forfeited");
    expect(result.money.grant?.result).toBe("granted");

    const keys = (await ledgerRows(accountId)).map((r) => r.idempotencyKey);
    expect(keys).toContain(subGrantKey(sub.id, oldStart));
    expect(keys).toContain(subForfeitKey(sub.id, oldStart));
    expect(keys).toContain(subGrantKey(sub.id, newStart));
    // Old unused grant clawed back, new period granted → exactly one period's
    // credits in the wallet.
    const wallet = await prisma.userCredits.findUniqueOrThrow({
      where: { accountId },
    });
    expect(wallet.balance).toBe(BigInt(monthlyCredits()));
  });

  test("dry-run (default) writes NOTHING and reports the plan", async () => {
    const accountId = await newAccount();
    const sub = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodStart: new Date(NOW.getTime() - 70 * DAY_MS),
      currentPeriodEnd: new Date(NOW.getTime() - 40 * DAY_MS),
    });
    const otx = sub.originalTransactionId ?? "";

    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otx, { status: APPLE_STATUS_EXPIRED }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otx,
        expiresDate: NOW.getTime() - 40 * DAY_MS,
      }),
    );

    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      now: NOW,
    });

    expect(summary.mode).toBe("dry-run");
    const result = summary.results[0];
    expect(result.outcome).toBe("planned");
    expect(result.intendedUpdate?.status).toBe(SubscriptionStatus.expired);
    // The plan predicts the forfeit no-op (never granted).
    expect(result.money.forfeit?.priorGrantExists).toBe(false);
    expect(result.money.forfeit?.result).toBeUndefined();

    // Nothing written: row untouched (status AND updatedAt), no ledger, no
    // wallet, no audit.
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after.status).toBe(SubscriptionStatus.active);
    expect(after.updatedAt.getTime()).toBe(sub.updatedAt.getTime());
    expect(await ledgerRows(accountId)).toHaveLength(0);
    expect(
      await prisma.userCredits.findUnique({ where: { accountId } }),
    ).toBeNull();
    expect(await auditRows(accountId)).toHaveLength(0);
  });

  test("allowlisted id without a Subscription row → no_row, nothing written", async () => {
    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: ["otx-does-not-exist"],
      apply: true,
      now: NOW,
    });
    expect(summary.results[0].outcome).toBe("no_row");
  });

  test("provider fetch failure → provider_unresolved, row untouched", async () => {
    const accountId = await newAccount();
    const sub = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodStart: new Date(NOW.getTime() - 70 * DAY_MS),
      currentPeriodEnd: new Date(NOW.getTime() - 40 * DAY_MS),
    });
    const otx = sub.originalTransactionId ?? "";

    getSubscriptionStatusesWithEnvironmentFallback.mockRejectedValue(
      new Error("apple 500"),
    );

    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });

    const result = summary.results[0];
    expect(result.outcome).toBe("provider_unresolved");
    expect(result.unresolvedReason).toBe("status_fetch_failed");
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after.status).toBe(SubscriptionStatus.active);
    expect(after.updatedAt.getTime()).toBe(sub.updatedAt.getTime());
  });

  test("billingRetry must not re-entitle nor extend period; grace entitles only until gracePeriodExpiresDate", async () => {
    // --- Leg 1a: EXPIRED row + Apple status 3 → NOT re-entitled. Writing
    // billingRetry would restore indefinite entitlement (status.ts no-TTL);
    // the mapping must fail safe and leave the row untouched.
    const accountA = await newAccount();
    const expiredRow = await seedAppleSub({
      accountId: accountA,
      status: SubscriptionStatus.expired,
      currentPeriodStart: new Date(NOW.getTime() - 70 * DAY_MS),
      currentPeriodEnd: new Date(NOW.getTime() - 40 * DAY_MS),
    });
    const otxA = expiredRow.originalTransactionId ?? "";

    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otxA, { status: APPLE_STATUS_BILLING_RETRY }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otxA,
        expiresDate: NOW.getTime() - 40 * DAY_MS,
      }),
    );

    let summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otxA],
      apply: true,
      now: NOW,
    });
    expect(summary.results[0].outcome).toBe("provider_unresolved");
    let after = await prisma.subscription.findUniqueOrThrow({
      where: { id: expiredRow.id },
    });
    expect(after.status).toBe(SubscriptionStatus.expired);
    expect(after.currentPeriodEnd.getTime()).toBe(
      expiredRow.currentPeriodEnd.getTime(),
    );
    expect(isEntitledSubscription(after, NOW)).toBe(false);
    expect(await ledgerRows(accountA)).toHaveLength(0);

    // --- Leg 1b: stale-ACTIVE row (effectively expired) + status 3 → row
    // untouched, period NOT extended, still not entitled.
    const accountB = await newAccount();
    const staleActive = await seedAppleSub({
      accountId: accountB,
      status: SubscriptionStatus.active,
      currentPeriodStart: new Date(NOW.getTime() - 70 * DAY_MS),
      currentPeriodEnd: new Date(NOW.getTime() - 40 * DAY_MS),
    });
    const otxB = staleActive.originalTransactionId ?? "";
    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otxB, { status: APPLE_STATUS_BILLING_RETRY }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otxB,
        expiresDate: NOW.getTime() - 40 * DAY_MS,
      }),
    );

    summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otxB],
      apply: true,
      now: NOW,
    });
    expect(summary.results[0].outcome).toBe("provider_unresolved");
    after = await prisma.subscription.findUniqueOrThrow({
      where: { id: staleActive.id },
    });
    expect(after.status).toBe(SubscriptionStatus.active);
    expect(after.updatedAt.getTime()).toBe(staleActive.updatedAt.getTime());
    expect(isEntitledSubscription(after, NOW)).toBe(false);
    expect(await ledgerRows(accountB)).toHaveLength(0);

    // --- Leg 2: Apple status 4 (grace) DOES entitle, but ONLY until
    // signedRenewalInfo.gracePeriodExpiresDate.
    const accountC = await newAccount();
    const periodStart = new Date(NOW.getTime() - 35 * DAY_MS);
    const graceRow = await seedAppleSub({
      accountId: accountC,
      status: SubscriptionStatus.active,
      currentPeriodStart: periodStart,
      currentPeriodEnd: new Date(NOW.getTime() - 5 * DAY_MS),
    });
    const otxC = graceRow.originalTransactionId ?? "";
    // Period was granted normally; grace must not re-mint.
    await seedGrantForPeriod(graceRow, periodStart);

    const graceDeadline = NOW.getTime() + 10 * DAY_MS;
    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otxC, {
        status: APPLE_STATUS_BILLING_GRACE,
        renewalJws: "jws-renewal-grace",
      }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otxC,
        expiresDate: NOW.getTime() - 5 * DAY_MS,
        purchaseDate: periodStart.getTime(),
      }),
    );
    verifyAndDecodeRenewalInfo.mockResolvedValue({
      gracePeriodExpiresDate: graceDeadline,
    });

    summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otxC],
      apply: true,
      now: NOW,
    });
    expect(summary.results[0].outcome).toBe("applied");
    after = await prisma.subscription.findUniqueOrThrow({
      where: { id: graceRow.id },
    });
    expect(after.status).toBe(SubscriptionStatus.grace);
    // Entitlement is bounded EXACTLY by the provider grace deadline.
    expect(after.gracePeriodEnd?.getTime()).toBe(graceDeadline);
    expect(isEntitledSubscription(after, NOW)).toBe(true);
    expect(isEntitledSubscription(after, new Date(graceDeadline - 1000))).toBe(
      true,
    );
    expect(isEntitledSubscription(after, new Date(graceDeadline))).toBe(false);
    expect(isEntitledSubscription(after, new Date(graceDeadline + 1000))).toBe(
      false,
    );
    // No re-mint: still exactly the one grant row.
    expect(await ledgerRows(accountC)).toHaveLength(1);
  });

  test("advancing end with a NON-advancing provider start keeps the stored period key (no re-key)", async () => {
    const accountId = await newAccount();
    const periodStart = new Date(NOW.getTime() - 20 * DAY_MS);
    const periodEnd = new Date(NOW.getTime() + 10 * DAY_MS);
    const sub = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });
    const otx = sub.originalTransactionId ?? "";
    await seedGrantForPeriod(sub, periodStart);

    // Provider end extends, but the provider start is OLDER than stored —
    // an incoherent period identity that must not re-key money.
    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otx, { status: APPLE_STATUS_ACTIVE }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otx,
        expiresDate: periodEnd.getTime() + 5 * DAY_MS,
        purchaseDate: periodStart.getTime() - 10 * DAY_MS,
      }),
    );

    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });

    const result = summary.results[0];
    expect(result.outcome).toBe("applied");
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    // Window extended, stored period identity kept, grant replayed under the
    // stored key — exactly one ledger row, no forfeit.
    expect(after.currentPeriodStart.getTime()).toBe(periodStart.getTime());
    expect(after.currentPeriodEnd.getTime()).toBe(
      periodEnd.getTime() + 5 * DAY_MS,
    );
    expect(await ledgerRows(accountId)).toHaveLength(1);
  });

  test("terminal verdict without a provider expiresDate fails safe (no blind terminalize+forfeit)", async () => {
    const accountId = await newAccount();
    const sub = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodStart: new Date(NOW.getTime() - 5 * DAY_MS),
      currentPeriodEnd: new Date(NOW.getTime() + 25 * DAY_MS),
    });
    const otx = sub.originalTransactionId ?? "";
    await seedGrantForPeriod(sub, sub.currentPeriodStart);

    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otx, { status: APPLE_STATUS_EXPIRED }),
    );
    // Decoded transaction lacks expiresDate entirely.
    verifyAndDecodeTransaction.mockResolvedValue({
      originalTransactionId: otx,
      transactionId: `tx-${randomUUID()}`,
      productId: "app.convos.subs.monthly",
    });

    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });

    const result = summary.results[0];
    expect(result.outcome).toBe("provider_unresolved");
    expect(result.unresolvedReason).toBe("ambiguous_provider_state");
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after.status).toBe(SubscriptionStatus.active);
    expect(await ledgerRows(accountId)).toHaveLength(1);
  });

  test("drifting provider purchaseDate on an unchanged window does NOT re-key the period (no double mint)", async () => {
    const accountId = await newAccount();
    const periodStart = new Date(NOW.getTime() - 5 * DAY_MS);
    const periodEnd = new Date(NOW.getTime() + 25 * DAY_MS);
    const sub = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });
    const otx = sub.originalTransactionId ?? "";
    // Current period already granted under the STORED period start.
    await seedGrantForPeriod(sub, periodStart);

    // Apple reports the same window end but a slightly different purchase
    // date — same real period, different would-be grant key.
    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otx, { status: APPLE_STATUS_ACTIVE }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otx,
        expiresDate: periodEnd.getTime(),
        purchaseDate: periodStart.getTime() - DAY_MS,
      }),
    );

    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });

    expect(summary.results[0].outcome).toBe("noop");
    expect(await ledgerRows(accountId)).toHaveLength(1);
  });

  test("stale terminal verdict (provider window older than stored) is refused wholesale", async () => {
    const accountId = await newAccount();
    const sub = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodStart: new Date(NOW.getTime() - 5 * DAY_MS),
      currentPeriodEnd: new Date(NOW.getTime() + 25 * DAY_MS),
    });
    const otx = sub.originalTransactionId ?? "";
    await seedGrantForPeriod(sub, sub.currentPeriodStart);

    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otx, { status: APPLE_STATUS_EXPIRED }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otx,
        expiresDate: NOW.getTime() - 100 * DAY_MS,
      }),
    );

    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });

    const result = summary.results[0];
    expect(result.outcome).toBe("provider_unresolved");
    expect(result.unresolvedReason).toBe("stale_provider_terminal");
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after.status).toBe(SubscriptionStatus.active);
    // The granted live period was NOT forfeited.
    expect(await ledgerRows(accountId)).toHaveLength(1);
  });

  test("already-terminal row: window backfill applies but NEVER retro-forfeits kept credits", async () => {
    const accountId = await newAccount();
    const periodStart = new Date(NOW.getTime() - 65 * DAY_MS);
    const sub = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.expired,
      currentPeriodStart: periodStart,
      currentPeriodEnd: new Date(NOW.getTime() - 35 * DAY_MS),
    });
    const otx = sub.originalTransactionId ?? "";
    // The (now over) period had been granted and the credits were kept.
    await seedGrantForPeriod(sub, periodStart);

    // Apple's final transaction ends LATER than our stored window.
    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otx, { status: APPLE_STATUS_EXPIRED }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otx,
        expiresDate: NOW.getTime() - 5 * DAY_MS,
      }),
    );

    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });

    const result = summary.results[0];
    expect(result.outcome).toBe("applied");
    expect(result.after?.currentPeriodEnd).toBe(
      new Date(NOW.getTime() - 5 * DAY_MS).toISOString(),
    );
    // No forfeit was planned or executed — pilot policy: no retroactive
    // clawback for rows that were already terminal.
    expect(result.money.forfeit).toBeUndefined();
    expect(await ledgerRows(accountId)).toHaveLength(1);
    const wallet = await prisma.userCredits.findUniqueOrThrow({
      where: { accountId },
    });
    expect(wallet.balance).toBe(BigInt(monthlyCredits()));
  });

  test("provider productId mismatch fails safe (no SKU remap in the pilot)", async () => {
    const accountId = await newAccount();
    const sub = await seedAppleSub({
      accountId,
      status: SubscriptionStatus.active,
      currentPeriodStart: new Date(NOW.getTime() - 70 * DAY_MS),
      currentPeriodEnd: new Date(NOW.getTime() - 40 * DAY_MS),
    });
    const otx = sub.originalTransactionId ?? "";

    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otx, { status: APPLE_STATUS_EXPIRED }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otx,
        expiresDate: NOW.getTime() - 40 * DAY_MS,
        productId: "app.convos.subs.annual",
      }),
    );

    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });

    const result = summary.results[0];
    expect(result.outcome).toBe("provider_unresolved");
    expect(result.unresolvedReason).toBe("product_id_mismatch");
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after.status).toBe(SubscriptionStatus.active);
    expect(await ledgerRows(accountId)).toHaveLength(0);
  });
});
