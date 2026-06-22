import { randomUUID } from "node:crypto";
import { LedgerReason, SubscriptionPeriod } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  creditsToUsd,
  getBalance,
  getBucketedConsumption,
  IdempotencyMismatchError,
  InsufficientBalanceError,
} from "@/payments";
import { config } from "@/payments/credits/config";
import {
  getSpendableBalance,
  isSpendAllowed,
  recordConsume,
  sumPeriodConsumes,
} from "@/payments/spendable";
import { tierGrant } from "@/subscriptions/tier-config";
import { SUBSCRIPTION_TIER_PLUS } from "@/subscriptions/tiers";
import { prisma } from "@/utils/prisma";
import {
  cleanupAccounts,
  seedAccount,
  seedBalance,
  seedExpiredSubscription,
  seedPlusMonthlySubscription,
} from "./helpers";

const tracker: string[] = [];
afterEach(async () => {
  await cleanupAccounts(tracker);
  tracker.length = 0;
});

const perPeriod = () =>
  tierGrant(SUBSCRIPTION_TIER_PLUS, SubscriptionPeriod.monthly).perPeriod;

const writeConsume = async (accountId: string, credits: number) => {
  await prisma.creditLedger.create({
    data: {
      accountId,
      delta: BigInt(-credits),
      reason: LedgerReason.consume,
      idempotencyKey: `c-${randomUUID()}`,
      scope: "transaction",
    },
  });
};

describe("getSpendableBalance / isSpendAllowed", () => {
  it("non-subscriber → raw ledger balance", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 4242n);
    expect(await getSpendableBalance(accountId)).toBe(4242n);
    expect(await isSpendAllowed(accountId)).toBe(true);
  });

  it("non-subscriber, no row → 0 and not allowed", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    expect(await getSpendableBalance(accountId)).toBe(0n);
    expect(await isSpendAllowed(accountId)).toBe(false);
  });

  it("entitled subscriber → perPeriod − periodConsumes", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await writeConsume(accountId, 100);
    expect(await getSpendableBalance(accountId)).toBe(
      BigInt(perPeriod() - 100),
    );
    expect(await isSpendAllowed(accountId)).toBe(true);
  });

  it("entitled subscriber at/over cap → 0 and not allowed", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await writeConsume(accountId, perPeriod() + 50);
    expect(await getSpendableBalance(accountId)).toBe(0n);
    expect(await isSpendAllowed(accountId)).toBe(
      config.reservedMaxTurnCredits <= 0n,
    );
  });

  it("lapsed subscriber → falls through to raw ledger balance", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedExpiredSubscription(accountId);
    await seedBalance(accountId, 1234n);
    // Subscription row exists but is not entitled → raw additive balance, not derived.
    expect(await getSpendableBalance(accountId)).toBe(1234n);
  });

  it("entitled subscriber with admin grant → perPeriod + raw grant", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    // Admin/promo/signup grants land in raw UserCredits.balance (seedBalance
    // calls grant()). For an entitled subscriber the derived allotment now adds
    // the raw bucket on top, so an admin grant is effective instead of a no-op.
    await seedBalance(accountId, 7777n);
    expect(await getSpendableBalance(accountId)).toBe(
      BigInt(perPeriod()) + 7777n,
    );
    expect(await isSpendAllowed(accountId)).toBe(true);
  });

  it("entitled subscriber, consume + admin grant → (perPeriod − used) + raw", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await writeConsume(accountId, 100);
    await seedBalance(accountId, 500n);
    expect(await getSpendableBalance(accountId)).toBe(
      BigInt(perPeriod() - 100) + 500n,
    );
  });

  it("entitled subscriber with zero raw balance → unchanged (derived only)", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await writeConsume(accountId, 100);
    // No raw grant → behavior identical to the pre-fix derived-only balance.
    expect(await getBalance(accountId)).toBe(0n);
    expect(await getSpendableBalance(accountId)).toBe(
      BigInt(perPeriod() - 100),
    );
  });

  it("entitled subscriber with negative raw balance → clamped, allotment intact", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    // Force a negative raw UserCredits.balance (e.g. legacy overspend). The
    // clamp must ensure raw never reduces the derived subscription allotment.
    await prisma.userCredits.create({
      data: { accountId, balance: -300n },
    });
    expect(await getBalance(accountId)).toBe(-300n);
    expect(await getSpendableBalance(accountId)).toBe(BigInt(perPeriod()));
  });
});

describe("recordConsume", () => {
  it("subscriber → ledger row written, raw balance untouched, never throws", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);

    const res = await recordConsume({
      accountId,
      usdCostMicros: 1_000_000n,
      idempotencyKey: `t-${randomUUID()}`,
      requestId: "req-1",
    });
    expect(res.spent).toBeGreaterThan(0);

    // Raw balance untouched (no UserCredits row created).
    expect(await getBalance(accountId)).toBe(0n);
    // Usage is recorded → spendable dropped by the consumed amount.
    expect(await getSpendableBalance(accountId)).toBe(
      BigInt(perPeriod() - res.spent),
    );
    const rows = await prisma.creditLedger.count({
      where: { accountId, reason: LedgerReason.consume },
    });
    expect(rows).toBe(1);
  });

  it("non-subscriber → identical to consume() (decrements raw balance)", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 5000n);

    const res = await recordConsume({
      accountId,
      usdCostMicros: 1_000_000n,
      idempotencyKey: `t-${randomUUID()}`,
      requestId: "req-2",
    });
    expect(await getBalance(accountId)).toBe(5000n - BigInt(res.spent));
  });

  it("subscriber idempotent replay → single row, replayed: true", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const key = `t-${randomUUID()}`;

    const first = await recordConsume({
      accountId,
      usdCostMicros: 1_000_000n,
      idempotencyKey: key,
      requestId: "req-r",
    });
    const second = await recordConsume({
      accountId,
      usdCostMicros: 1_000_000n,
      idempotencyKey: key,
      requestId: "req-r",
    });

    expect(second.replayed).toBe(true);
    expect(second.ledgerId).toBe(first.ledgerId);
    const rows = await prisma.creditLedger.count({
      where: { accountId, reason: LedgerReason.consume },
    });
    expect(rows).toBe(1);
  });

  it("record-only subscriber consume surfaces in bucketed consumption", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const res = await recordConsume({
      accountId,
      usdCostMicros: 1_000_000n,
      idempotencyKey: `u-${randomUUID()}`,
      requestId: "req-u",
    });

    const buckets = await getBucketedConsumption(accountId, since, "day");
    const total = buckets.reduce((n, b) => n + Number(b.consumed), 0);
    expect(total).toBe(res.spent);
  });
});

// `creditsToUsd(n)` is the exact inverse of `usdToCredits`, so passing its
// result as `usdCostMicros` charges EXACTLY `n` credits — letting these
// money-correctness tests assert raw decrements to the credit.
const microsForCredits = (credits: number): bigint => creditsToUsd(credits);

const consumeCredits = (
  accountId: string,
  credits: number,
  requestId = "req",
) =>
  recordConsume({
    accountId,
    usdCostMicros: microsForCredits(credits),
    idempotencyKey: `t-${randomUUID()}`,
    requestId,
  });

describe("recordConsume — derived→raw spend allocation (money-correctness)", () => {
  it("BLOCKING-FIX: raw burns once derived allotment is exhausted, then spend is blocked", async () => {
    // Reproduces codex finding #1: entitled sub with perPeriod derived + an
    // admin/raw grant G. Pre-fix, raw was never decremented → unbounded spend.
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const G = 600;
    await seedBalance(accountId, BigInt(G));
    const per = perPeriod();

    // (1) Consume strictly WITHIN the derived allotment → raw untouched.
    await consumeCredits(accountId, per - 100);
    expect(await getBalance(accountId)).toBe(BigInt(G));
    expect(await getSpendableBalance(accountId)).toBe(BigInt(100 + G));

    // (2) Consume that exceeds remaining derived (=100) by X=250 → raw −250.
    const X = 250;
    await consumeCredits(accountId, 100 + X);
    expect(await getBalance(accountId)).toBe(BigInt(G - X)); // 350
    expect(await getSpendableBalance(accountId)).toBe(BigInt(G - X)); // derived=0

    // (3) Further consume keeps decrementing raw (derived already 0).
    await consumeCredits(accountId, 100);
    expect(await getBalance(accountId)).toBe(BigInt(G - X - 100)); // 250

    // (4) Drain remaining raw exactly to 0 → spend now blocked.
    await consumeCredits(accountId, G - X - 100);
    expect(await getBalance(accountId)).toBe(0n);
    expect(await getSpendableBalance(accountId)).toBe(0n);
    expect(await isSpendAllowed(accountId)).toBe(false);

    // The whole charge across the period equals derived + (G drained from raw).
    void per;
  });

  it("sub with raw=0 → capped at derived, raw never goes negative within allotment", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const per = perPeriod();

    // Consume the full allotment with no raw grant. Every credit is derived
    // (record-only) → no UserCredits row decrement.
    await consumeCredits(accountId, per);
    expect(await getBalance(accountId)).toBe(0n);
    expect(await getSpendableBalance(accountId)).toBe(0n);
    expect(await isSpendAllowed(accountId)).toBe(false);
  });

  it("boundary: consume == derivedRemaining → raw untouched", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await seedBalance(accountId, 500n);
    const per = perPeriod();

    await consumeCredits(accountId, per); // exactly the derived allotment
    expect(await getBalance(accountId)).toBe(500n); // raw exactly untouched
    expect(await getSpendableBalance(accountId)).toBe(500n);
  });

  it("boundary: consume == derivedRemaining + 1 → raw −1", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await seedBalance(accountId, 500n);
    const per = perPeriod();

    await consumeCredits(accountId, per + 1); // one credit over the allotment
    expect(await getBalance(accountId)).toBe(499n); // raw decremented by exactly 1
    expect(await getSpendableBalance(accountId)).toBe(499n);
  });

  it("single consume spanning derived + overflow in one call → raw −overflow exactly", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await seedBalance(accountId, 1000n);
    const per = perPeriod();

    // First spend half the allotment, then one consume of (remaining + 300).
    await consumeCredits(accountId, per - 800);
    expect(await getBalance(accountId)).toBe(1000n);

    const res = await consumeCredits(accountId, 800 + 300);
    expect(res.spent).toBe(1100);
    expect(await getBalance(accountId)).toBe(700n); // raw −300, derived −800
    expect(await getSpendableBalance(accountId)).toBe(700n);
  });

  it("idempotent replay of a split consume → raw decremented exactly once", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await seedBalance(accountId, 1000n);
    const per = perPeriod();
    const key = `t-${randomUUID()}`;
    const micros = microsForCredits(per + 400); // 400 overflow

    const first = await recordConsume({
      accountId,
      usdCostMicros: micros,
      idempotencyKey: key,
      requestId: "req-idem",
    });
    expect(first.spent).toBe(per + 400);
    expect(await getBalance(accountId)).toBe(600n); // raw −400

    const second = await recordConsume({
      accountId,
      usdCostMicros: micros,
      idempotencyKey: key,
      requestId: "req-idem",
    });
    expect(second.replayed).toBe(true);
    expect(second.spent).toBe(per + 400);
    // Raw NOT decremented a second time.
    expect(await getBalance(accountId)).toBe(600n);

    // Exactly two consume rows total (one derived, one overflow) — no dup.
    const rows = await prisma.creditLedger.count({
      where: { accountId, reason: LedgerReason.consume },
    });
    expect(rows).toBe(2);
  });

  it("replay with a DIFFERENT body → IdempotencyMismatchError (409 contract)", async () => {
    // reconstructReplay must enforce the same Stripe-style body-match the
    // non-subscriber path does: a reused key with a different usdCostMicros is a
    // caller bug, not a legitimate retry.
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await seedBalance(accountId, 1000n);
    const per = perPeriod();
    const key = `t-${randomUUID()}`;

    const first = await recordConsume({
      accountId,
      usdCostMicros: microsForCredits(per + 400),
      idempotencyKey: key,
      requestId: "req-mismatch",
    });
    expect(first.spent).toBe(per + 400);

    // Same key, different amount → mismatch on the derived anchor's cost snapshot.
    await expect(
      recordConsume({
        accountId,
        usdCostMicros: microsForCredits(per + 800),
        idempotencyKey: key,
        requestId: "req-mismatch",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);

    // Same amount but a different requestId also mismatches (caller-bug detection).
    await expect(
      recordConsume({
        accountId,
        usdCostMicros: microsForCredits(per + 400),
        idempotencyKey: key,
        requestId: "req-different",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);

    // Raw was never decremented a second time by the rejected replays.
    expect(await getBalance(accountId)).toBe(600n);
  });

  it("legitimate replay returns the ORIGINAL balanceAfter snapshot, not a live read", async () => {
    // The replayed result must equal the original split's stored snapshot even
    // after raw drifts. Prove it by mutating raw between the two calls and
    // confirming the replay still returns the original balanceAfter.
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await seedBalance(accountId, 1000n);
    const per = perPeriod();
    const key = `t-${randomUUID()}`;
    const micros = microsForCredits(per + 400); // 400 overflow → raw 1000 → 600

    const first = await recordConsume({
      accountId,
      usdCostMicros: micros,
      idempotencyKey: key,
      requestId: "req-snap",
    });
    expect(first.balanceAfter).toBe(600n);

    // Drift raw — a live getBalance() at replay time would now return 123n.
    await prisma.userCredits.update({
      where: { accountId },
      data: { balance: 123n },
    });

    const second = await recordConsume({
      accountId,
      usdCostMicros: micros,
      idempotencyKey: key,
      requestId: "req-snap",
    });
    expect(second.replayed).toBe(true);
    expect(second.spent).toBe(first.spent);
    expect(second.ledgerId).toBe(first.ledgerId);
    // Original snapshot returned, NOT the drifted live balance (123n).
    expect(second.balanceAfter).toBe(600n);
    expect(second.newBalance).toBe(600n);
  });

  it("derived-only replay (no overflow) returns the derived anchor's snapshot", async () => {
    // When the whole charge fit inside the allotment there is no raw leg, so the
    // snapshot comes from the derived anchor's balanceAfter (raw untouched).
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await seedBalance(accountId, 1000n);
    const per = perPeriod();
    const key = `t-${randomUUID()}`;
    const micros = microsForCredits(per - 100); // wholly within derived allotment

    const first = await recordConsume({
      accountId,
      usdCostMicros: micros,
      idempotencyKey: key,
      requestId: "req-derived-only",
    });
    expect(first.balanceAfter).toBe(1000n); // raw untouched

    await prisma.userCredits.update({
      where: { accountId },
      data: { balance: 7n },
    });

    const second = await recordConsume({
      accountId,
      usdCostMicros: micros,
      idempotencyKey: key,
      requestId: "req-derived-only",
    });
    expect(second.replayed).toBe(true);
    expect(second.balanceAfter).toBe(1000n); // anchor snapshot, not the drifted 7n
  });

  it("overflow beyond the floor → InsufficientBalanceError, raw not driven past floor", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const per = perPeriod();
    // No raw grant. minBalance = -1000, so overflow can dip to -1000 but a
    // larger overflow must be refused atomically.
    await consumeCredits(accountId, per); // exhaust derived
    expect(await getBalance(accountId)).toBe(0n);

    const floor = config.minBalance; // -1000n
    const overBy = Number(-floor) + 1; // 1001 → breaches floor
    await expect(consumeCredits(accountId, overBy)).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
    // Raw untouched by the refused overflow (transaction rolled back).
    expect(await getBalance(accountId)).toBe(0n);
  });

  it("non-subscriber consume path is unchanged (single row, real raw decrement)", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 5000n);

    const res = await consumeCredits(accountId, 1200);
    expect(res.spent).toBe(1200);
    expect(await getBalance(accountId)).toBe(3800n);
    // No split: exactly one consume row, keyed by the caller key (no -d/-r).
    const rows = await prisma.creditLedger.count({
      where: { accountId, reason: LedgerReason.consume },
    });
    expect(rows).toBe(1);
  });
});

describe("recordConsume — atomic split (S-N1) + serialized split (S-N2)", () => {
  it("S-N1: derivedPortion>0 AND overflow breaches floor → 402 AND BOTH legs rolled back", async () => {
    // The partial-commit case the round-2 review flagged: a single charge that
    // both consumes part of the derived allotment AND overflows past the floor.
    // Pre-fix the derived (recordOnly) row committed in its own transaction
    // before the overflow's separate transaction breached the floor → the
    // allotment leaked for a turn that 402'd. Now both writes share one tx, so
    // the floor breach must roll the derived row back too.
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const per = perPeriod(); // 2500 derived remaining, raw = 0

    const floor = config.minBalance; // -1000n
    const overflowOverFloor = Number(-floor) + 1; // 1001 → breaches floor
    const key = `t-${randomUUID()}`;

    // derivedPortion = 2500 (>0), overflow = 1001 → would drive raw to -1001.
    await expect(
      recordConsume({
        accountId,
        usdCostMicros: microsForCredits(per + overflowOverFloor),
        idempotencyKey: key,
        requestId: "req-atomic",
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    // No leaked derived row: ZERO consume rows persisted for this account, and
    // crucially neither sub-key (-d / -r) exists.
    const rows = await prisma.creditLedger.count({
      where: { accountId, reason: LedgerReason.consume },
    });
    expect(rows).toBe(0);
    const derivedRow = await prisma.creditLedger.findFirst({
      where: { accountId, idempotencyKey: `${key}-d` },
    });
    expect(derivedRow).toBeNull();

    // Raw bucket completely untouched, full allotment still spendable.
    expect(await getBalance(accountId)).toBe(0n);
    expect(await getSpendableBalance(accountId)).toBe(BigInt(per));
  });

  it("S-N1: within-budget overflow → derived row + raw decrement BOTH commit", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await seedBalance(accountId, 500n);
    const per = perPeriod();
    const key = `t-${randomUUID()}`;

    // derivedPortion = 2500, overflow = 300, raw 500 → 200 (floor -1000 OK).
    const res = await recordConsume({
      accountId,
      usdCostMicros: microsForCredits(per + 300),
      idempotencyKey: key,
      requestId: "req-commit",
    });
    expect(res.spent).toBe(per + 300);

    // Exactly two rows committed: derived anchor (-d) + overflow (-r).
    const rows = await prisma.creditLedger.count({
      where: { accountId, reason: LedgerReason.consume },
    });
    expect(rows).toBe(2);
    const derivedRow = await prisma.creditLedger.findFirst({
      where: { accountId, idempotencyKey: `${key}-d` },
    });
    const rawRow = await prisma.creditLedger.findFirst({
      where: { accountId, idempotencyKey: `${key}-r` },
    });
    expect(derivedRow?.delta).toBe(BigInt(-per));
    expect(rawRow?.delta).toBe(-300n);

    // Raw decremented by exactly the overflow.
    expect(await getBalance(accountId)).toBe(200n);
  });

  it("S-N1: after a floor-breached turn nothing leaked → the retry charges cleanly", async () => {
    // Because the failed turn rolled back entirely (no -d anchor persisted),
    // a re-attempt is a fresh consume, not a poisoned replay. Proves the
    // allotment is NOT lost for the 402'd turn.
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const per = perPeriod();
    const key = `t-${randomUUID()}`;
    const floor = config.minBalance;

    // First attempt overflows past the floor → 402, full rollback.
    await expect(
      recordConsume({
        accountId,
        usdCostMicros: microsForCredits(per + Number(-floor) + 1),
        idempotencyKey: key,
        requestId: "req-1",
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(await getSpendableBalance(accountId)).toBe(BigInt(per));

    // Retry within budget (just the derived allotment) now succeeds — the
    // allotment was never leaked.
    const res = await recordConsume({
      accountId,
      usdCostMicros: microsForCredits(per),
      idempotencyKey: `${key}-retry`,
      requestId: "req-2",
    });
    expect(res.spent).toBe(per);
    expect(res.replayed).toBe(false);
    expect(await getSpendableBalance(accountId)).toBe(0n);
  });

  it("S-N2: concurrent consumes serialize on the lock → no derived over-allocation", async () => {
    // Two concurrent charges (distinct idempotency keys) on a fresh allotment.
    // Pre-fix both read the same derivedRemaining before either inserted, so
    // both could allocate the full split to derived and under-burn raw. With
    // the UserCredits row lock taken FIRST inside each consume's transaction,
    // the two serialize: the second sees the first's committed derived row in
    // its aggregate and overflows the remainder to raw.
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const per = perPeriod(); // 2500 derived
    await seedBalance(accountId, 4000n); // ample raw so neither leg 402s

    // Each charge is (3/4 of the allotment). Two of them = 1.5× allotment, so
    // exactly half an allotment MUST spill into raw. If the split were
    // double-allocated (both fully derived) raw would stay at 4000.
    const each = Math.floor((per * 3) / 4); // 1875
    const [r1, r2] = await Promise.all([
      recordConsume({
        accountId,
        usdCostMicros: microsForCredits(each),
        idempotencyKey: `t-${randomUUID()}`,
        requestId: "req-c1",
      }),
      recordConsume({
        accountId,
        usdCostMicros: microsForCredits(each),
        idempotencyKey: `t-${randomUUID()}`,
        requestId: "req-c2",
      }),
    ]);

    expect(r1.spent).toBe(each);
    expect(r2.spent).toBe(each);

    // Total charged = 2 * each. Derived absorbs at most `per`; the rest burns
    // raw. Raw must drop by exactly (2*each − per), proving no double-alloc.
    const expectedRawBurn = 2 * each - per; // 1250
    expect(await getBalance(accountId)).toBe(BigInt(4000 - expectedRawBurn));

    // The period aggregate equals the full charge (derived capped + overflow).
    const totalConsumed = await sumPeriodConsumes(
      accountId,
      new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    );
    expect(totalConsumed).toBe(2 * each);

    // Spendable is now derived-exhausted + remaining raw.
    expect(await getSpendableBalance(accountId)).toBe(
      BigInt(4000 - expectedRawBurn),
    );
  });

  it("S-N2: concurrent same-key consumes resolve idempotently (single charge)", async () => {
    // Same idempotency key fired twice concurrently. The pre-tx replay check can
    // miss the sibling (neither has committed yet), so one transaction wins the
    // unique-key race and the other hits P2002 inside the locked tx. The catch
    // reconstructs the aggregate from the committed rows → both callers see the
    // same single charge, raw decremented exactly once.
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await seedBalance(accountId, 1000n);
    const per = perPeriod();
    const key = `t-${randomUUID()}`;
    const micros = microsForCredits(per + 400); // 400 overflow

    const [a, b] = await Promise.all([
      recordConsume({
        accountId,
        usdCostMicros: micros,
        idempotencyKey: key,
        requestId: "req-same",
      }),
      recordConsume({
        accountId,
        usdCostMicros: micros,
        idempotencyKey: key,
        requestId: "req-same",
      }),
    ]);

    expect(a.spent).toBe(per + 400);
    expect(b.spent).toBe(per + 400);
    // Raw decremented by exactly 400 — once, not twice.
    expect(await getBalance(accountId)).toBe(600n);
    // Exactly two ledger rows total (one derived, one overflow) — no duplicate.
    const rows = await prisma.creditLedger.count({
      where: { accountId, reason: LedgerReason.consume },
    });
    expect(rows).toBe(2);
  });
});
