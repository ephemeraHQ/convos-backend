import { afterEach, describe, expect, test } from "vitest";
import { getBalance } from "@/payments";
import { subGrantKey } from "@/subscriptions/grants";
import {
  applyNotification,
  BillingProvider,
  findAppleByOriginalTransactionId,
  findCurrentByAccountId,
  findReceiptByTransactionId,
  serializeUserSubscription,
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionAccountMismatchError,
  SubscriptionPeriod,
  SubscriptionStatus,
  upsertFromVerify,
  type AppleVerifyInput,
} from "@/subscriptions/repository";
import { tierGrant } from "@/subscriptions/tier-config";
import { prisma } from "@/utils/prisma";

const perPeriod = () =>
  tierGrant(SUBSCRIPTION_TIER_PLUS, SubscriptionPeriod.monthly).perPeriod;

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

const verifyInput = (
  overrides: Partial<AppleVerifyInput>,
): AppleVerifyInput => ({
  provider: BillingProvider.apple,
  accountId: overrides.accountId ?? "",
  appAccountToken:
    overrides.appAccountToken ?? "11111111-2222-3333-4444-555555555555",
  productId: overrides.productId ?? "app.convos.subs.monthly",
  tier: overrides.tier ?? SUBSCRIPTION_TIER_PLUS,
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
  await prisma.billingReceipt.deleteMany({
    where: { subscription: { accountId: { in: accountIds } } },
  });
  await prisma.subscription.deleteMany({
    where: { accountId: { in: accountIds } },
  });
  // Single-ledger: verify/renewal now write sub_grant ledger rows, so clear
  // the wallet + ledger before deleting the account (FK).
  await prisma.creditLedger.deleteMany({
    where: { accountId: { in: accountIds } },
  });
  await prisma.userCredits.deleteMany({
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
    expect(subscription.tier).toBe(SUBSCRIPTION_TIER_PLUS);
    expect(subscription.status).toBe(SubscriptionStatus.active);
    expect(receiptCreated).toBe(true);

    const receipt = await findReceiptByTransactionId(
      BillingProvider.apple,
      "tx-1",
    );
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

    const receipts = await prisma.billingReceipt.findMany({
      where: { transactionId: "tx-2" },
    });
    expect(receipts).toHaveLength(1);
  });

  test("verify replay does not roll newer subscription state backwards", async () => {
    const accountId = await newAccount();
    const otid = "otid-stale-verify";

    const newer = await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: otid,
        transactionId: "tx-newer",
        currentPeriodStart: new Date("2026-06-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-07-01T00:00:00.000Z"),
      }),
    );

    const stale = await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: otid,
        transactionId: "tx-stale",
        status: SubscriptionStatus.expired,
        currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );

    expect(stale.receiptCreated).toBe(true);
    expect(stale.subscription.id).toBe(newer.subscription.id);
    expect(stale.subscription.status).toBe(SubscriptionStatus.active);
    expect(stale.subscription.currentPeriodEnd.toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );

    const receipts = await prisma.billingReceipt.findMany({
      where: { subscriptionId: newer.subscription.id },
    });
    expect(receipts.map((r) => r.transactionId).sort()).toEqual([
      "tx-newer",
      "tx-stale",
    ]);
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

    const receipts = await prisma.billingReceipt.findMany({
      where: { subscriptionId: first.subscription.id },
      orderBy: [{ receivedAt: "asc" }, { transactionId: "asc" }],
    });
    expect(receipts).toHaveLength(2);
    expect(receipts.map((r) => r.transactionId)).toEqual(["tx-3a", "tx-3b"]);
  });

  test("cross-account verify is rejected: same originalTransactionId, different accountId throws account-mismatch", async () => {
    const accountA = await newAccount();
    const accountB = await newAccount();
    const otid = "otid-mismatch";

    const first = await upsertFromVerify(
      verifyInput({
        accountId: accountA,
        appAccountToken: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        originalTransactionId: otid,
        transactionId: "tx-mismatch-a",
      }),
    );

    let caught: unknown;
    try {
      await upsertFromVerify(
        verifyInput({
          accountId: accountB,
          appAccountToken: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          originalTransactionId: otid,
          transactionId: "tx-mismatch-b",
        }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SubscriptionAccountMismatchError);
    const mismatch = caught as SubscriptionAccountMismatchError;
    expect(mismatch.existingAccountId).toBe(accountA);
    expect(mismatch.attemptedAccountId).toBe(accountB);
    expect(mismatch.providerSubscriptionId).toBe(otid);

    // Account A keeps ownership of the row; account B persisted nothing.
    const forA = await findCurrentByAccountId(accountA);
    expect(forA?.id).toBe(first.subscription.id);
    expect(forA?.accountId).toBe(accountA);
    expect(await findCurrentByAccountId(accountB)).toBeNull();

    // No AppleReceipt was created for account B's losing verify.
    const receiptB = await findReceiptByTransactionId(
      BillingProvider.apple,
      "tx-mismatch-b",
    );
    expect(receiptB).toBeNull();
  });

  // AAT-collision (account recreation): iOS generates the appAccountToken per
  // INSTALL, so it survives account deletion + recreation. The recreated
  // account's fresh purchase carries a NEW originalTransactionId, so
  // findExistingForVerify sees no row, Subscription.create fires, and Postgres
  // rejects it on the (provider, appAccountToken) unique held by the OLD
  // account's row. This used to fall through reReadAfterRace (OTX-only re-read
  // → null) to a raw rethrow — a 500 to the user. It must surface the standard
  // account-mismatch (→ 409) instead.
  test("same appAccountToken, different account + different OTX: account-mismatch, not a 500", async () => {
    const accountA = await newAccount();
    const accountB = await newAccount();
    const aat = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    const first = await upsertFromVerify(
      verifyInput({
        accountId: accountA,
        appAccountToken: aat,
        originalTransactionId: "otid-aat-a",
        transactionId: "tx-aat-a",
      }),
    );

    let caught: unknown;
    try {
      await upsertFromVerify(
        verifyInput({
          accountId: accountB,
          appAccountToken: aat,
          originalTransactionId: "otid-aat-b",
          transactionId: "tx-aat-b",
        }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SubscriptionAccountMismatchError);
    const mismatch = caught as SubscriptionAccountMismatchError;
    expect(mismatch.existingAccountId).toBe(accountA);
    expect(mismatch.attemptedAccountId).toBe(accountB);
    expect(mismatch.providerSubscriptionId).toBe("otid-aat-b");

    // Account A keeps ownership; account B persisted nothing.
    expect((await findCurrentByAccountId(accountA))?.id).toBe(
      first.subscription.id,
    );
    expect(await findCurrentByAccountId(accountB)).toBeNull();
    expect(await findAppleByOriginalTransactionId("otid-aat-b")).toBeNull();
    expect(
      await findReceiptByTransactionId(BillingProvider.apple, "tx-aat-b"),
    ).toBeNull();
  });

  test("same appAccountToken, SAME account, different OTX: resolves idempotently to the existing row", async () => {
    const accountId = await newAccount();
    const aat = "dddddddd-dddd-dddd-dddd-dddddddddddd";

    const first = await upsertFromVerify(
      verifyInput({
        accountId,
        appAccountToken: aat,
        originalTransactionId: "otid-aat-same-1",
        transactionId: "tx-aat-same-1",
      }),
    );
    // Same account re-purchasing under the same install token: the create
    // loses on the AAT unique, and the caller already holds the row → replay
    // semantics (mirrors the cold-start race resolution), not a crash.
    const second = await upsertFromVerify(
      verifyInput({
        accountId,
        appAccountToken: aat,
        originalTransactionId: "otid-aat-same-2",
        transactionId: "tx-aat-same-2",
      }),
    );
    expect(second.receiptCreated).toBe(false);
    expect(second.subscription.id).toBe(first.subscription.id);
    // No double period grant either.
    expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));
  });

  test("concurrent verifies, same accountId: exactly one creates the receipt, both return the same subscription", async () => {
    const accountId = await newAccount();
    const input = verifyInput({
      accountId,
      originalTransactionId: "otid-concurrent-same",
      transactionId: "tx-concurrent-same",
    });

    const [a, b] = await Promise.all([
      upsertFromVerify(input),
      upsertFromVerify(input),
    ]);

    expect([a.receiptCreated, b.receiptCreated].sort()).toEqual([false, true]);
    expect(a.subscription.id).toBe(b.subscription.id);
    expect(a.subscription.accountId).toBe(accountId);

    const receipts = await prisma.billingReceipt.findMany({
      where: { transactionId: "tx-concurrent-same" },
    });
    expect(receipts).toHaveLength(1);
  });

  // #2 regression: when two concurrent dup /verify calls race PAST the
  // `existingReceipt` pre-check and both reach `billingReceipt.create`, the
  // loser hits a BillingReceipt-idempotencyKey P2002. The narrowed catch must
  // route that to reReadAfterRace → { receiptCreated: false }, NOT rethrow a
  // 500. Run several trials to actually exercise the concurrent window.
  test("concurrent dup verifies resolve idempotently — loser never throws (BillingReceipt P2002 routed)", async () => {
    const TRIALS = 8;
    for (let i = 0; i < TRIALS; i++) {
      const accountId = await newAccount();
      const input = verifyInput({
        accountId,
        originalTransactionId: `otid-dup-${i}`,
        transactionId: `tx-dup-${i}`,
        appAccountToken: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      });

      const results = await Promise.allSettled([
        upsertFromVerify(input),
        upsertFromVerify(input),
      ]);

      // Neither call rejects — both resolve idempotently.
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const values = results.flatMap((r) =>
        r.status === "fulfilled" ? [r.value] : [],
      );
      // Exactly one created the receipt; the other returned receiptCreated:false.
      expect(values.map((v) => v.receiptCreated).sort()).toEqual([false, true]);
      // Both see the same subscription, owned by the caller.
      expect(values[0].subscription.id).toBe(values[1].subscription.id);
      expect(values[0].subscription.accountId).toBe(accountId);
      // Exactly one receipt persisted.
      const receipts = await prisma.billingReceipt.findMany({
        where: { transactionId: `tx-dup-${i}` },
      });
      expect(receipts).toHaveLength(1);
    }
  });

  // Verify-replay materializer: subscribers who bought BEFORE the single-ledger
  // deploy (#324) have a Subscription + BillingReceipt but no `sub_grant` row
  // for the period they are living in — the replay short-circuit used to return
  // before the grant, so re-verify could never heal them. These tests pin the
  // new behavior: a replayed verify backfills a MISSING current-period grant,
  // and only that — no double-grant, no grant on stale replays, no grant for
  // rows whose EFFECTIVE (time-aware) status is not entitled, including
  // stored-`active` rows whose entitlement window already elapsed (lost
  // EXPIRED webhook).
  describe("replay materializes missing current-period grant", () => {
    // The backfill gate is time-aware (`isEntitledSubscription`), so entitled
    // fixtures need a period window that actually spans "now" — fixed calendar
    // dates would silently lapse as the wall clock passes them.
    const DAY = 24 * 60 * 60 * 1000;
    const CURRENT_START = new Date(Date.now() - 5 * DAY);
    const CURRENT_END = new Date(Date.now() + 25 * DAY);

    // Simulate the pre-deploy state: subscription + receipt exist, but the
    // period's sub_grant ledger row was never written (grants only started
    // being written at deploy time). Deleting the row and unwinding its delta
    // reproduces exactly that shape.
    const stripPeriodGrant = async (
      subscriptionId: string,
      accountId: string,
      periodStart: Date,
    ) => {
      const key = subGrantKey(subscriptionId, periodStart);
      const row = await prisma.creditLedger.findUnique({
        where: {
          accountId_idempotencyKey: { accountId, idempotencyKey: key },
        },
      });
      if (!row) return;
      await prisma.creditLedger.delete({ where: { id: row.id } });
      await prisma.userCredits.update({
        where: { accountId },
        data: { balance: { decrement: row.delta } },
      });
    };

    const countSubGrants = (accountId: string) =>
      prisma.creditLedger.count({
        where: { accountId, grantKindId: "sub_grant" },
      });

    test("replayed verify backfills the missing grant (pre-deploy subscriber heals)", async () => {
      const accountId = await newAccount();
      const input = verifyInput({
        accountId,
        originalTransactionId: "otid-materialize",
        transactionId: "tx-materialize",
        currentPeriodStart: CURRENT_START,
        currentPeriodEnd: CURRENT_END,
      });
      const first = await upsertFromVerify(input);
      expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));

      await stripPeriodGrant(
        first.subscription.id,
        accountId,
        first.subscription.currentPeriodStart,
      );
      expect(await getBalance(accountId)).toBe(0n);

      const replay = await upsertFromVerify(input);
      expect(replay.receiptCreated).toBe(false);
      expect(replay.subscription.id).toBe(first.subscription.id);
      // The missing period grant was materialized by the replay.
      expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));
      expect(await countSubGrants(accountId)).toBe(1);
      // Still exactly one receipt — replay semantics intact.
      const receipts = await prisma.billingReceipt.findMany({
        where: { transactionId: "tx-materialize" },
      });
      expect(receipts).toHaveLength(1);
    });

    test("replayed verify with the grant present does not double-grant", async () => {
      const accountId = await newAccount();
      const input = verifyInput({
        accountId,
        originalTransactionId: "otid-no-double",
        transactionId: "tx-no-double",
        currentPeriodStart: CURRENT_START,
        currentPeriodEnd: CURRENT_END,
      });
      await upsertFromVerify(input);
      const replay = await upsertFromVerify(input);
      expect(replay.receiptCreated).toBe(false);
      expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));
      expect(await countSubGrants(accountId)).toBe(1);
    });

    test("stale replay does not materialize the advanced period's grant", async () => {
      const accountId = await newAccount();
      const otid = "otid-stale-no-materialize";
      const oldInput = verifyInput({
        accountId,
        originalTransactionId: otid,
        transactionId: "tx-stale-old",
        currentPeriodStart: new Date(CURRENT_START.getTime() - 30 * DAY),
        currentPeriodEnd: CURRENT_START,
      });
      await upsertFromVerify(oldInput);
      // Renewal advances the row to period 2 (spanning now) and grants it.
      const renewed = await upsertFromVerify(
        verifyInput({
          accountId,
          originalTransactionId: otid,
          transactionId: "tx-stale-new",
          currentPeriodStart: CURRENT_START,
          currentPeriodEnd: CURRENT_END,
        }),
      );
      expect(await getBalance(accountId)).toBe(BigInt(perPeriod() * 2));

      // Remove period 2's grant, then replay the OLD transaction. Its period
      // end predates the stored one → stale → must NOT backfill period 2.
      await stripPeriodGrant(
        renewed.subscription.id,
        accountId,
        renewed.subscription.currentPeriodStart,
      );
      const replay = await upsertFromVerify(oldInput);
      expect(replay.receiptCreated).toBe(false);
      expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));
      expect(await countSubGrants(accountId)).toBe(1);
    });

    test("replay of a non-entitled (expired) subscription does not grant", async () => {
      const accountId = await newAccount();
      const input = verifyInput({
        accountId,
        originalTransactionId: "otid-expired-replay",
        transactionId: "tx-expired-replay",
        status: SubscriptionStatus.expired,
      });
      await upsertFromVerify(input);
      expect(await getBalance(accountId)).toBe(0n);
      const replay = await upsertFromVerify(input);
      expect(replay.receiptCreated).toBe(false);
      expect(await getBalance(accountId)).toBe(0n);
      expect(await countSubGrants(accountId)).toBe(0);
    });

    // Time-aware gate regression: a row whose STORED status is still `active`
    // but whose currentPeriodEnd already passed (lost/delayed EXPIRED webhook
    // — prod holds such rows) must NOT get a backfill for the lapsed period.
    // effectiveSubscriptionStatus resolves it to `expired`; the stored-status
    // check alone would have minted a full sub_grant that credits-get
    // simultaneously frames as free-tier state.
    test("stored-active row with an elapsed period: replay does NOT backfill the lapsed grant", async () => {
      const accountId = await newAccount();
      const input = verifyInput({
        accountId,
        originalTransactionId: "otid-lapsed-active",
        transactionId: "tx-lapsed-active",
        status: SubscriptionStatus.active,
        currentPeriodStart: new Date(Date.now() - 35 * DAY),
        currentPeriodEnd: new Date(Date.now() - 5 * DAY),
      });
      // The FRESH verify still grants (stored-status gate, provider-fresh
      // input; forfeit-on-expiry is the reconciliation path) — pinned
      // elsewhere by account-credits "past-ended active subscription".
      const first = await upsertFromVerify(input);
      expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));

      // Simulate the pre-deploy shape: the grant row is missing.
      await stripPeriodGrant(
        first.subscription.id,
        accountId,
        first.subscription.currentPeriodStart,
      );
      expect(await getBalance(accountId)).toBe(0n);

      // Replay: NOT stale (same period), stored status entitled — but the
      // effective status is expired, so the healer must refuse.
      const replay = await upsertFromVerify(input);
      expect(replay.receiptCreated).toBe(false);
      expect(await getBalance(accountId)).toBe(0n);
      expect(await countSubGrants(accountId)).toBe(0);
    });
  });

  test("concurrent verifies, different accountId: exactly one wins, the other rejects with account-mismatch", async () => {
    const accountA = await newAccount();
    const accountB = await newAccount();
    const otid = "otid-concurrent-race";

    const results = await Promise.allSettled([
      upsertFromVerify(
        verifyInput({
          accountId: accountA,
          appAccountToken: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          originalTransactionId: otid,
          transactionId: "tx-race-a",
        }),
      ),
      upsertFromVerify(
        verifyInput({
          accountId: accountB,
          appAccountToken: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          originalTransactionId: otid,
          transactionId: "tx-race-b",
        }),
      ),
    ]);

    const fulfilled = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    const rejected = results.flatMap((r) =>
      r.status === "rejected" ? [r.reason as unknown] : [],
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(SubscriptionAccountMismatchError);

    const winner = fulfilled[0].subscription.accountId;
    expect([accountA, accountB]).toContain(winner);

    const persisted = await findAppleByOriginalTransactionId(otid);
    expect(persisted?.accountId).toBe(winner);
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
        appAccountToken: "11111111-1111-1111-1111-111111111111",
        originalTransactionId: "otid-revoked",
        transactionId: "tx-revoked",
        status: SubscriptionStatus.revoked,
        currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );
    await upsertFromVerify(
      verifyInput({
        accountId,
        appAccountToken: "22222222-2222-2222-2222-222222222222",
        originalTransactionId: "otid-expired-later",
        transactionId: "tx-expired-later",
        status: SubscriptionStatus.expired,
        currentPeriodEnd: new Date("2026-07-01T00:00:00.000Z"),
      }),
    );
    const current = await findCurrentByAccountId(accountId);
    expect(current).not.toBeNull();
    expect(current?.status).toBe(SubscriptionStatus.expired);
    expect(current?.originalTransactionId).toBe("otid-expired-later");
  });
});

describe("applyNotification", () => {
  test("returns unknown_subscription when originalTransactionId has no row", async () => {
    const result = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: "otid-missing",
      transactionId: "tx-missing",
      notificationUUID: "notif-missing",
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
      provider: BillingProvider.apple,
      originalTransactionId: "otid-apply",
      transactionId: "tx-apply-2",
      notificationUUID: "notif-apply-2",
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

    const receipt = await findReceiptByTransactionId(
      BillingProvider.apple,
      "tx-apply-2",
    );
    expect(receipt?.notificationType).toBe("DID_FAIL_TO_RENEW");
    expect(receipt?.notificationSubtype).toBe("GRACE_PERIOD");
  });

  test("returns replayed when notificationUUID was already recorded — no double state apply", async () => {
    const accountId = await newAccount();
    await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: "otid-replay",
        transactionId: "tx-replay-initial",
      }),
    );

    const first = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: "otid-replay",
      transactionId: "tx-replay-1",
      notificationUUID: "notif-replay-1",
      notificationType: "DID_RENEW",
      signedPayload: "stub",
      update: { status: SubscriptionStatus.active },
    });
    expect(first.kind).toBe("applied");

    // Same notificationUUID → replayed. The state update would have been a no-op
    // anyway, but the point is no second AppleReceipt row.
    const second = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: "otid-replay",
      transactionId: "tx-replay-1",
      notificationUUID: "notif-replay-1",
      notificationType: "DID_RENEW",
      signedPayload: "stub",
      update: { status: SubscriptionStatus.expired },
    });
    expect(second.kind).toBe("replayed");
    if (second.kind === "replayed") {
      // Critically: status did NOT flip to expired.
      expect(second.subscription.status).toBe(SubscriptionStatus.active);
    }

    const receipts = await prisma.billingReceipt.findMany({
      where: { transactionId: "tx-replay-1" },
    });
    expect(receipts).toHaveLength(1);
  });

  test("same transactionId with a new notificationUUID is a distinct Apple event", async () => {
    const accountId = await newAccount();
    await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: "otid-same-tx-different-uuid",
        transactionId: "tx-same-uuid-initial",
      }),
    );

    const first = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: "otid-same-tx-different-uuid",
      transactionId: "tx-shared",
      notificationUUID: "notif-shared-a",
      notificationType: "DID_CHANGE_RENEWAL_STATUS",
      signedPayload: "stub-a",
      update: { willRenew: false },
    });
    expect(first.kind).toBe("applied");

    const second = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: "otid-same-tx-different-uuid",
      transactionId: "tx-shared",
      notificationUUID: "notif-shared-b",
      notificationType: "DID_CHANGE_RENEWAL_STATUS",
      signedPayload: "stub-b",
      update: { willRenew: true },
    });
    expect(second.kind).toBe("applied");

    const receipts = await prisma.billingReceipt.findMany({
      where: { transactionId: "tx-shared" },
      orderBy: { externalNotificationId: "asc" },
    });
    expect(receipts.map((r) => r.externalNotificationId)).toEqual([
      "notif-shared-a",
      "notif-shared-b",
    ]);
  });

  // #3 staleness guard: a valid-but-OUT-OF-ORDER terminal notification (an
  // EXPIRED for a period a later renewal already superseded) must NOT roll the
  // active row back to expired NOR forfeit the now-active period.
  test("stale EXPIRED arriving after a renewal does NOT change status or forfeit", async () => {
    const accountId = await newAccount();
    const otid = "otid-stale-expired";
    const oldEnd = new Date("2026-06-01T00:00:00.000Z");
    const newStart = new Date("2026-06-01T00:00:00.000Z");
    const newEnd = new Date("2026-07-01T00:00:00.000Z");

    // Initial verify → grants period 1.
    await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: otid,
        transactionId: "tx-stale-initial",
        currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
        currentPeriodEnd: oldEnd,
      }),
    );
    // Renewal advances the period → grants period 2. Wallet now holds 2×.
    const renew = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otid,
      transactionId: "tx-stale-renew",
      notificationUUID: "notif-stale-renew",
      notificationType: "DID_RENEW",
      signedPayload: "stub",
      update: {
        status: SubscriptionStatus.active,
        currentPeriodStart: newStart,
        currentPeriodEnd: newEnd,
        willRenew: true,
      },
    });
    expect(renew.kind).toBe("applied");
    expect(await getBalance(accountId)).toBe(BigInt(perPeriod() * 2));

    // Now a STALE EXPIRED for the OLD period (currentPeriodEnd = oldEnd < newEnd).
    const stale = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otid,
      transactionId: "tx-stale-expired",
      notificationUUID: "notif-stale-expired",
      notificationType: "EXPIRED",
      signedPayload: "stub",
      update: {
        status: SubscriptionStatus.expired,
        willRenew: false,
        currentPeriodEnd: oldEnd,
      },
    });
    // Receipt recorded (idempotency preserved) but state NOT rolled back.
    expect(stale.kind).toBe("applied");
    if (stale.kind === "applied") {
      expect(stale.subscription.status).toBe(SubscriptionStatus.active);
      expect(stale.subscription.currentPeriodEnd.toISOString()).toBe(
        newEnd.toISOString(),
      );
    }
    // No forfeit — wallet untouched.
    expect(await getBalance(accountId)).toBe(BigInt(perPeriod() * 2));
    const forfeitRows = await prisma.creditLedger.count({
      where: { accountId, grantKindId: "sub_forfeit" },
    });
    expect(forfeitRows).toBe(0);
    // The stale receipt is still recorded for audit.
    const receipt = await findReceiptByTransactionId(
      BillingProvider.apple,
      "tx-stale-expired",
    );
    expect(receipt).not.toBeNull();
  });

  // #3 counterpart: a LEGITIMATE mid-period refund/revoke (its period end is the
  // CURRENT one, not older) is NOT stale → it applies the terminal status AND
  // forfeits the unused portion.
  test("mid-period REVOKE for the current period applies and forfeits", async () => {
    const accountId = await newAccount();
    const otid = "otid-midperiod-revoke";
    const periodEnd = new Date("2026-06-01T00:00:00.000Z");

    await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: otid,
        transactionId: "tx-revoke-initial",
        currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
        currentPeriodEnd: periodEnd,
      }),
    );
    expect(await getBalance(accountId)).toBe(BigInt(perPeriod()));

    // REVOKE carrying the CURRENT period end (== stored) → not stale.
    const revoke = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId: otid,
      transactionId: "tx-revoke-now",
      notificationUUID: "notif-revoke-now",
      notificationType: "REVOKE",
      signedPayload: "stub",
      update: {
        status: SubscriptionStatus.revoked,
        willRenew: false,
        cancelledAt: new Date("2026-05-15T00:00:00.000Z"),
        currentPeriodEnd: periodEnd,
      },
    });
    expect(revoke.kind).toBe("applied");
    if (revoke.kind === "applied") {
      expect(revoke.subscription.status).toBe(SubscriptionStatus.revoked);
    }
    // Nothing consumed → whole period forfeited, wallet back to 0.
    expect(await getBalance(accountId)).toBe(0n);
    const forfeitRows = await prisma.creditLedger.count({
      where: { accountId, grantKindId: "sub_forfeit" },
    });
    expect(forfeitRows).toBe(1);
  });
});

describe("findAppleByOriginalTransactionId", () => {
  test("returns the matching subscription", async () => {
    const accountId = await newAccount();
    const { subscription } = await upsertFromVerify(
      verifyInput({
        accountId,
        originalTransactionId: "otid-find",
        transactionId: "tx-find",
      }),
    );
    const found = await findAppleByOriginalTransactionId("otid-find");
    expect(found?.id).toBe(subscription.id);
  });

  test("returns null when not found", async () => {
    expect(await findAppleByOriginalTransactionId("nope")).toBeNull();
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
        tier: SUBSCRIPTION_TIER_PLUS,
        period: SubscriptionPeriod.annual,
        status: SubscriptionStatus.trial,
        productId: "app.convos.subs.annual",
        isInTrial: true,
        willRenew: true,
        currentPeriodEnd: new Date("2027-05-01T00:00:00.000Z"),
      }),
    );
    expect(serializeUserSubscription(subscription)).toEqual({
      provider: BillingProvider.apple,
      tier: SUBSCRIPTION_TIER_PLUS,
      period: SubscriptionPeriod.annual,
      status: SubscriptionStatus.trial,
      productId: "app.convos.subs.annual",
      currentPeriodEnd: "2027-05-01T00:00:00.000Z",
      willRenew: true,
      isInTrial: true,
    });
  });
});
