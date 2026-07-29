import { randomUUID } from "node:crypto";
import { BillingProvider, SubscriptionStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { subForfeitKey, subGrantKey } from "@/subscriptions/grants";
import { runAppleAllowlistReconcile } from "@/subscriptions/reconcile/service";
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
}) => ({
  originalTransactionId: opts.originalTransactionId,
  transactionId: `tx-${randomUUID()}`,
  productId: "app.convos.subs.monthly",
  purchaseDate: opts.purchaseDate ?? opts.expiresDate - 30 * DAY_MS,
  expiresDate: opts.expiresDate,
});

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
    // sub_grant for the live period.
    getSubscriptionStatusesWithEnvironmentFallback.mockResolvedValue(
      appleStatusResponse(otx, { status: APPLE_STATUS_ACTIVE }),
    );
    verifyAndDecodeTransaction.mockResolvedValue(
      decodedTransaction({
        originalTransactionId: otx,
        expiresDate: periodEnd.getTime(),
        purchaseDate: periodStart.getTime(),
      }),
    );

    const summary = await runAppleAllowlistReconcile({
      originalTransactionIds: [otx],
      apply: true,
      now: NOW,
    });

    const result = summary.results[0];
    expect(result.outcome).toBe("applied");
    expect(result.money.grant?.result).toBe("granted");
    expect(result.money.grant?.credits).toBe(monthlyCredits());
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
    await prisma.$transaction(async (tx) => {
      const { grantSubscriptionPeriod } =
        await import("@/subscriptions/grants");
      await grantSubscriptionPeriod(tx, {
        subscription: sub,
        periodStart: oldStart,
      });
    });

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
});
