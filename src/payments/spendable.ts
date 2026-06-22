import { LedgerReason, Prisma } from "@prisma/client";
import {
  consume,
  getBalance,
  InsufficientBalanceError,
  usdToCredits,
} from "@/payments";
import { config } from "@/payments/credits/config";
import {
  applyDeltaWithTx,
  findLedgerByIdempotencyKey,
  LedgerFloorBreachError,
  lockUserCreditsBalance,
  validateReplayPayload,
  type ApplyDeltaInput,
} from "@/payments/ledger";
import type { ConsumeResult } from "@/payments/types";
import { findCurrentByAccountId } from "@/subscriptions/repository";
import { isEntitledSubscription } from "@/subscriptions/status";
import { tierGrant } from "@/subscriptions/tier-config";
import { requireSubscriptionTier } from "@/subscriptions/tiers";
import { prisma } from "@/utils/prisma";

// Accepts either the top-level client or a transaction client, so the consume
// split can run the aggregate INSIDE its locked transaction (see recordConsume).
type CreditLedgerClient = Pick<typeof prisma, "creditLedger">;

const sumPeriodConsumesWith = async (
  client: CreditLedgerClient,
  accountId: string,
  since: Date,
): Promise<number> => {
  const agg = await client.creditLedger.aggregate({
    where: {
      accountId,
      reason: LedgerReason.consume,
      createdAt: { gte: since },
    },
    _sum: { delta: true },
  });
  const sum = agg._sum.delta;
  if (sum === null) return 0;
  return Number(sum < 0n ? -sum : sum);
};

export const sumPeriodConsumes = (
  accountId: string,
  since: Date,
): Promise<number> => sumPeriodConsumesWith(prisma, accountId, since);

export const getSpendableBalance = async (
  accountId: string,
): Promise<bigint> => {
  const subscription = await findCurrentByAccountId(accountId);
  if (subscription && isEntitledSubscription(subscription)) {
    const grant = tierGrant(
      requireSubscriptionTier(subscription.tier),
      subscription.period,
    );
    const used = await sumPeriodConsumes(
      accountId,
      subscription.currentPeriodStart,
    );
    const remaining = grant.perPeriod - Math.min(used, grant.perPeriod);
    // Add any raw (admin/promo/signup) credits on top of the derived
    // subscription allotment so admin grants can unblock a stuck subscriber.
    // The two buckets are disjoint — subscription credits are derived and
    // never written to UserCredits.balance, while admin/promo/signup grants
    // land only in raw — so summing them cannot double-count. Clamp raw to
    // >= 0 so a negative raw balance never reduces the subscription allotment.
    const raw = await getBalance(accountId);
    return BigInt(remaining) + (raw > 0n ? raw : 0n);
  }
  return getBalance(accountId);
};

export const isSpendAllowed = async (accountId: string): Promise<boolean> =>
  (await getSpendableBalance(accountId)) >= config.reservedMaxTurnCredits;

/**
 * Derived allotment still available to an entitled subscriber this period:
 * `max(0, perPeriod − periodConsumes)`. Mirrors the `remaining` term in
 * `getSpendableBalance`/`credits-get`, so the consume-time split below stays
 * consistent with what `isSpendAllowed` reports.
 */
const derivedRemainingForSubscription = async (
  client: CreditLedgerClient,
  accountId: string,
  subscription: NonNullable<Awaited<ReturnType<typeof findCurrentByAccountId>>>,
): Promise<number> => {
  const grant = tierGrant(
    requireSubscriptionTier(subscription.tier),
    subscription.period,
  );
  const used = await sumPeriodConsumesWith(
    client,
    accountId,
    subscription.currentPeriodStart,
  );
  return grant.perPeriod - Math.min(used, grant.perPeriod);
};

/**
 * Consume credits for an entitled subscriber, splitting the charge across the
 * two disjoint buckets so raw credits actually deplete:
 *
 *   spendable = derivedRemaining + max(0, raw)
 *   derivedRemaining = max(0, perPeriod − sumPeriodConsumes(periodStart))
 *
 *   • derivedPortion = min(credits, derivedRemaining)  → record-only ledger row
 *       (no UserCredits.balance change), exactly as the subscriber path always
 *       behaved while the monthly allotment lasts.
 *   • overflow       = max(0, credits − derivedRemaining) → a REAL consume()
 *       that decrements UserCredits.balance, identical to the non-subscriber
 *       path (floor check + InsufficientBalanceError mapping included).
 *
 * Why this is money-exact (no double / zero decrement):
 *   - Raw is decremented by exactly `overflow`, and only by the overflow row.
 *     The derived row never touches UserCredits.balance.
 *   - Both rows are `consume` ledger rows, so `sumPeriodConsumes` (capped at
 *     `perPeriod`) accounts for total usage; once derivedRemaining hits 0 the
 *     overflow is counted but clamped away, so it is never charged twice
 *     against the allotment.
 *   - Idempotency: the two rows use deterministic sub-keys derived from the
 *     caller key. On replay we re-detect the prior derived row FIRST and return
 *     the prior aggregate result WITHOUT recomputing the split — recomputing
 *     would see the prior rows in `sumPeriodConsumes` and produce a different
 *     (wrong) split. This guarantees a retried consume never decrements raw a
 *     second time.
 *
 * Why this is ATOMIC + SERIALIZED (S-N1 + S-N2):
 *   - Atomicity (S-N1): the derived (recordOnly) row AND the overflow (raw
 *     decrement) row are written inside ONE `prisma.$transaction` via
 *     `applyDeltaWithTx`. If the overflow breaches the floor (or any error is
 *     thrown), the whole transaction rolls back — the derived row never
 *     commits. Pre-fix these were two separate top-level transactions, so a
 *     floor breach on the overflow left the derived allotment spent for a turn
 *     that ultimately 402'd, and the idempotent replay then returned that
 *     leaked aggregate while never charging the overflow.
 *   - Serialization (S-N2): the transaction takes a row lock on the
 *     `UserCredits` row FIRST (`lockUserCreditsBalance`) and computes
 *     `derivedRemaining` from a tx-scoped `sumPeriodConsumes` INSIDE the lock.
 *     Two concurrent subscriber consumes therefore serialize on that lock — the
 *     second sees the first's committed derived row in its aggregate and can no
 *     longer double-allocate the same remainder. Pre-fix the remainder was read
 *     before any lock, so concurrent charges both allocated to derived and
 *     under-burned raw.
 *
 * Non-subscriber callers never reach this function — they short-circuit to the
 * plain `consume()` at the top of `recordConsume`.
 */
const DERIVED_KEY_SUFFIX = "-d";
const RAW_KEY_SUFFIX = "-r";

/**
 * Reconstruct the prior aggregate `ConsumeResult` from the two committed
 * sub-rows of an earlier split (the derived anchor + optional overflow). Used
 * both by the sequential replay short-circuit and by the concurrent same-key
 * path where the locked transaction lost the unique-key race (P2002).
 *
 * Contract parity with the non-subscriber path (`applyDelta`'s P2002 replay,
 * `ledger/repository.ts:267-285`):
 *   1. STRICT replay validation. We re-run `validateReplayPayload` on BOTH the
 *      derived anchor (`-d`) and the raw overflow (`-r`) legs, so an entitled
 *      subscriber reusing a key with a DIFFERENT body (e.g. different
 *      `usdCostMicros`/`requestId`/`model`) throws `IdempotencyMismatchError`
 *      → 409, exactly like the non-subscriber endpoint. The per-leg `delta` is
 *      split-derived (it depends on the period-consumes aggregate at the
 *      ORIGINAL write time, which a replay must not recompute), so it is not a
 *      request-contract field — we neutralize the `delta` check by passing the
 *      stored delta and let the cost-snapshot/identity fields do the matching.
 *   2. `balanceAfter` is reconstructed from the STORED row snapshots — the raw
 *      leg's `balanceAfter` if it exists, else the derived anchor's — NOT a
 *      live `getBalance()`. This makes the replayed response byte-identical to
 *      the original even after intervening consumes. `getBalance()` is only a
 *      deploy-gap fallback for the nullable `balanceAfter` column (mirrors
 *      `applyDelta`).
 */
const reconstructReplay = async (
  args: {
    accountId: string;
    usdCostMicros: bigint;
    requestId: string;
    model?: string;
  },
  priorDerived: NonNullable<
    Awaited<ReturnType<typeof findLedgerByIdempotencyKey>>
  >,
  derivedKey: string,
  rawKey: string,
): Promise<ConsumeResult> => {
  // Derived anchor leg: carries the turn's full cost snapshot. Validate every
  // request-contract field against the new request (delta neutralized — see above).
  validateReplayPayload(priorDerived, {
    accountId: args.accountId,
    delta: priorDerived.delta,
    reason: LedgerReason.consume,
    idempotencyKey: derivedKey,
    scope: "transaction",
    usdCostMicros: args.usdCostMicros,
    markupRate: config.markupRate,
    creditsPerDollar: config.creditsPerDollar,
    model: args.model,
    requestId: args.requestId,
  } satisfies ApplyDeltaInput);

  const priorRaw = await findLedgerByIdempotencyKey({
    accountId: args.accountId,
    idempotencyKey: rawKey,
    scope: "transaction",
  });
  if (priorRaw) {
    // Raw overflow leg: written WITHOUT a cost snapshot (the anchor owns it),
    // so validate only the fields the original `-r` write set.
    validateReplayPayload(priorRaw, {
      accountId: args.accountId,
      delta: priorRaw.delta,
      reason: LedgerReason.consume,
      idempotencyKey: rawKey,
      scope: "transaction",
      model: args.model,
      requestId: args.requestId,
    } satisfies ApplyDeltaInput);
  }

  const derivedSpent = Number(-priorDerived.delta);
  const rawSpent = priorRaw ? Number(-priorRaw.delta) : 0;
  // Original split's balance snapshot: the raw leg's `balanceAfter` is the
  // post-overflow balance; with no overflow the derived anchor's snapshot is
  // the (unchanged) balance. Fall back to a live read only if the column is
  // NULL (pre-Migration-2 deploy-gap row), matching the non-subscriber path.
  const balanceAfter =
    priorRaw?.balanceAfter ??
    priorDerived.balanceAfter ??
    (await getBalance(args.accountId));
  return {
    spent: derivedSpent + rawSpent,
    replayed: true,
    newBalance: balanceAfter,
    balanceAfter,
    ledgerId: priorDerived.id,
  };
};

export const recordConsume = async (args: {
  accountId: string;
  usdCostMicros: bigint;
  idempotencyKey: string;
  requestId: string;
  model?: string;
}): Promise<ConsumeResult> => {
  const subscription = await findCurrentByAccountId(args.accountId);
  if (!subscription || !isEntitledSubscription(subscription)) {
    return consume(args);
  }

  const credits = usdToCredits(args.usdCostMicros);
  const derivedKey = `${args.idempotencyKey}${DERIVED_KEY_SUFFIX}`;
  const rawKey = `${args.idempotencyKey}${RAW_KEY_SUFFIX}`;

  // Replay short-circuit: if the derived row already exists for this key, this
  // is a retry. Reconstruct the prior aggregate from the two sub-rows instead
  // of recomputing the split (which would mis-allocate against the now-larger
  // period consumption). Guarantees no double raw decrement on retry.
  const priorDerived = await findLedgerByIdempotencyKey({
    accountId: args.accountId,
    idempotencyKey: derivedKey,
    scope: "transaction",
  });
  if (priorDerived) {
    return reconstructReplay(args, priorDerived, derivedKey, rawKey);
  }

  // Single locked transaction (S-N1 atomicity + S-N2 serialization):
  //
  //   1. Lock the UserCredits row FIRST. Concurrent subscriber consumes on this
  //      account now serialize here, so the derivedRemaining read below reflects
  //      every prior committed consume — no two charges can allocate the same
  //      remainder.
  //   2. Compute derivedRemaining from a tx-scoped aggregate (inside the lock).
  //   3. Write the derived (recordOnly) row and the overflow (raw decrement) row
  //      with the same `tx`. A floor breach on the overflow throws inside the
  //      transaction → BOTH writes roll back, so a 402'd turn never leaks the
  //      derived allotment.
  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockUserCreditsBalance(tx, args.accountId);

      const derivedRemaining = await derivedRemainingForSubscription(
        tx,
        args.accountId,
        subscription,
      );
      const derivedPortion = Math.min(credits, Math.max(0, derivedRemaining));
      const overflow = credits - derivedPortion;

      // Derived portion: record-only ledger row, no raw balance change. Always
      // written (even when 0) so the replay short-circuit above has a stable
      // anchor and the returned ledgerId is deterministic across the split.
      const derivedRow = await applyDeltaWithTx(tx, {
        accountId: args.accountId,
        delta: BigInt(-derivedPortion),
        reason: LedgerReason.consume,
        idempotencyKey: derivedKey,
        scope: "transaction",
        usdCostMicros: args.usdCostMicros,
        markupRate: config.markupRate,
        creditsPerDollar: config.creditsPerDollar,
        model: args.model,
        requestId: args.requestId,
        recordOnly: true,
      });

      // Overflow portion: real decrement of UserCredits.balance by EXACTLY
      // `overflow` credits, identical to the non-subscriber path (same floor
      // check + InsufficientBalanceError mapping). We decrement `-overflow`
      // directly rather than routing through consume(usdCostMicros), so the raw
      // bucket burns by the exact derived-overflow amount with no micros↔credits
      // re-rounding. The turn's full `usdCostMicros` cost snapshot is attributed
      // only to the derived (anchor) row above; the overflow row carries no cost
      // snapshot so a future cost-report summing `usdCostMicros` cannot
      // double-count the split. Skipped when the whole charge fit inside the
      // derived allotment. A floor breach here rolls back the derived row too.
      let rawBalanceAfter = derivedRow.balanceAfter;
      if (overflow > 0) {
        const rawRow = await applyDeltaWithTx(tx, {
          accountId: args.accountId,
          delta: BigInt(-overflow),
          reason: LedgerReason.consume,
          idempotencyKey: rawKey,
          scope: "transaction",
          model: args.model,
          requestId: args.requestId,
          floorCheck: { minBalance: config.minBalance },
        });
        rawBalanceAfter = rawRow.balanceAfter;
      }

      return {
        spent: credits,
        replayed: derivedRow.replayed,
        newBalance: rawBalanceAfter,
        balanceAfter: rawBalanceAfter,
        ledgerId: derivedRow.ledgerId,
      } satisfies ConsumeResult;
    });
    return result;
  } catch (err) {
    // Floor breach on the overflow → both legs rolled back → surface a clean
    // 402-mapping error (raw untouched, derived allotment NOT leaked).
    if (err instanceof LedgerFloorBreachError) {
      throw new InsufficientBalanceError(
        args.accountId,
        err.currentBalance,
        err.attempted,
        err.minBalance,
      );
    }
    // Concurrent same-key race: a parallel consume committed the derived row
    // after our pre-tx replay check but before our insert. `applyDeltaWithTx`
    // does not run the P2002 replay fallback, so the unique-key violation aborts
    // our transaction here. Treat it as a replay and reconstruct the aggregate
    // from the now-committed rows — preserving idempotency (no double charge).
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const committedDerived = await findLedgerByIdempotencyKey({
        accountId: args.accountId,
        idempotencyKey: derivedKey,
        scope: "transaction",
      });
      if (committedDerived) {
        return reconstructReplay(args, committedDerived, derivedKey, rawKey);
      }
    }
    throw err;
  }
};
