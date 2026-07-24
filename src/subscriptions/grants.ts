import {
  BillingProvider,
  LedgerReason,
  type Prisma,
  type Subscription,
} from "@prisma/client";
import { applyDeltaWithTx, lockUserCreditsBalance } from "@/payments/ledger";
import { createHeldCustody } from "@/subscriptions/custody";
import type { LineageLockContext } from "@/subscriptions/lineage";
import { tierGrant } from "@/subscriptions/tier-config";
import { requireSubscriptionTier } from "@/subscriptions/tiers";

type TxClient = Prisma.TransactionClient;

/**
 * Single-ledger subscription money-in / money-out.
 *
 * Subscriptions are no longer derived at read time — subscribe + each renewal
 * write a real `sub_grant` credit row into the one wallet (`UserCredits`), and
 * expiry/refund/revoke write a bounded `sub_forfeit` adjustment that
 * removes ONLY the unused subscription portion (never admin/promo/signup
 * credits sharing the same wallet).
 *
 * Both helpers run inside the caller's transaction (verify / notification both
 * already open one) so the credit move and the Subscription row update commit
 * atomically.
 */

const periodEpoch = (periodStart: Date): number =>
  Math.floor(periodStart.getTime() / 1000);

// Ledger idempotency keys are Stripe-style `[A-Za-z0-9_-]` (no colons), so the
// plan's conceptual `sub_grant:{id}:{periodStartEpoch}` form is rendered with
// underscores. Subscription ids are UUIDs (already dashed); the `{epoch}` suffix
// keeps one row per (sub, period).

/** Idempotency key for the per-period grant. One row per (sub, period). */
export const subGrantKey = (
  subscriptionId: string,
  periodStart: Date,
): string => `sub_grant_${subscriptionId}_${periodEpoch(periodStart)}`;

/** Ledger keys admit `[A-Za-z0-9_-]` only; provider event ids can carry
 *  dots (Google order ids like `GPA.xxxx..0`). */
const sanitizeKeyPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9_-]/g, "-");

/**
 * Event-derived grant key for providers whose reported period start never
 * advances. Google's `startTime` is the subscription-lifetime start, so the
 * epoch-based key above collides across renewals and would suppress every
 * grant after the first; the funding-event identity (`play_order_<id>`) is
 * the correct per-charge key.
 */
export const subGrantKeyForEvent = (
  subscriptionId: string,
  providerPeriodKey: string,
): string =>
  `sub_grant_${subscriptionId}_${sanitizeKeyPart(providerPeriodKey)}`;

/** Idempotency key for the per-period forfeit. One row per (sub, period). */
export const subForfeitKey = (
  subscriptionId: string,
  periodStart: Date,
): string => `sub_forfeit_${subscriptionId}_${periodEpoch(periodStart)}`;

const findLedgerRow = (
  tx: TxClient,
  accountId: string,
  idempotencyKey: string,
) =>
  tx.creditLedger.findUnique({
    where: { accountId_idempotencyKey: { accountId, idempotencyKey } },
  });

/**
 * |consume deltas| in `[since, until)` (defaulting to open-ended when `until` is
 * omitted), as a positive credit total. Renewal forfeits pass `until = the new
 * period start` so spends made after the ending period are attributed to the new
 * period, not clawed back against the old one; the terminal (expiry) forfeit
 * omits `until` — that period has no successor, so every spend since its start
 * belongs to it.
 *
 * S1 KNOWN APPROXIMATION (n=1, safe direction): the wallet is commingled —
 * `consume` rows carry no funding-source/bucket metadata, so we cannot tell a
 * spend that drew down subscription credits from one that drew down
 * admin/promo/signup credits. We therefore attribute ALL period consumes to the
 * subscription portion when computing `unusedSub = periodGrant − consumes`. This
 * can only OVER-count consumes → UNDER-forfeit (a lapsed sub may retain
 * subscription credits up to the non-sub amount spent in the period); it can
 * never over-claw. Admin/promo/signup credits stay protected by the
 * `max(0, …)` floor on `unusedSub` and the locked `min(balance, unusedSub)`
 * clamp in `forfeitSubscriptionPeriod`. Clean attribution would require tagging
 * each consume with its funding bucket — over-engineering for n=1 and tracked as
 * a follow-up if subscription volume grows.
 */
export const sumConsumesBetween = async (
  tx: TxClient,
  accountId: string,
  since: Date,
  until?: Date,
): Promise<number> => {
  const agg = await tx.creditLedger.aggregate({
    where: {
      accountId,
      reason: LedgerReason.consume,
      createdAt:
        until === undefined ? { gte: since } : { gte: since, lt: until },
    },
    _sum: { delta: true },
  });
  const sum = agg._sum.delta;
  if (sum === null) return 0;
  return Number(sum < 0n ? -sum : sum);
};

const sumPeriodGrants = async (
  tx: TxClient,
  accountId: string,
  idempotencyKey: string,
): Promise<number> => {
  const row = await findLedgerRow(tx, accountId, idempotencyKey);
  if (!row) return 0;
  const delta = row.delta;
  return Number(delta < 0n ? -delta : delta);
};

export type GrantSubscriptionPeriodResult =
  | { kind: "granted"; credits: number; subscription: Subscription }
  | { kind: "replayed" }
  | { kind: "skipped_nonpositive" };

/**
 * Lineage context for the global once-per-period funding registry. When
 * provided (verify/notification paths that hold the lineage lock), the grant
 * additionally writes the LineagePeriodGrant registry row and the held
 * custody row, and enforces the new-period gate: a funding event whose
 * period window does not advance past the last funded period (e.g. a
 * mid-period upgrade minting a new transactionId) records nothing and grants
 * nothing.
 */
export type GrantLineageContext = {
  ctx: LineageLockContext;
  /** Provider funding-event key: apple_txn_<id> / play_order_<id>. */
  providerPeriodKey: string;
  /**
   * Effective custody-window start for this funding event. Callers derive it
   * provider-correctly: Apple uses the transaction's purchaseDate; Google
   * clamps the lifetime `startTime` up to the previous known period end so
   * consecutive custody rows do not overlap.
   */
  periodStart: Date;
  periodEnd: Date;
};

/**
 * Write the per-period subscription allotment as a real `grant` ledger row,
 * idempotent on `sub_grant:{subscription.id}:{periodStartEpoch}` per account
 * and — when lineage context is provided — once per provider funding event
 * globally (LineagePeriodGrant). Safe to call from the verify path and the
 * renewal-notification path; a webhook retry, an Apple S2S DID_RENEW racing
 * the iOS /verify for the same period, or a re-verify all resolve to the
 * same keys and no-op.
 *
 * Runs inside the caller's transaction. The account key is derived from the
 * internal stable `subscription.id` (NOT a provider token — Play rotates
 * purchaseToken).
 */
export const grantSubscriptionPeriod = async (
  tx: TxClient,
  args: {
    subscription: Subscription;
    periodStart: Date;
    lineage?: GrantLineageContext;
  },
): Promise<GrantSubscriptionPeriodResult> => {
  const { subscription, periodStart, lineage } = args;
  const credits = tierGrant(
    requireSubscriptionTier(subscription.tier),
    subscription.period,
  ).perPeriod;
  if (credits <= 0) {
    return { kind: "skipped_nonpositive" };
  }

  // Apple keeps the legacy epoch-based key (per-period purchaseDate advances
  // every renewal, and pre-lineage production rows were written under this
  // shape, so replays must keep resolving). Google derives the key from the
  // funding-event identity: its reported period start is the lifetime
  // startTime and never advances, so the epoch key would collide across
  // renewals and suppress every grant after the first.
  const idempotencyKey =
    lineage && subscription.provider === BillingProvider.googlePlay
      ? subGrantKeyForEvent(subscription.id, lineage.providerPeriodKey)
      : subGrantKey(subscription.id, periodStart);

  if (lineage) {
    // Global funding-registry dedupe: this provider event (or any event that
    // already funded this or a later period) means no new allotment,
    // whichever account carried it at the time.
    const registryHit = await tx.lineagePeriodGrant.findUnique({
      where: {
        lineageId_providerPeriodKey: {
          lineageId: lineage.ctx.lineageId,
          providerPeriodKey: lineage.providerPeriodKey,
        },
      },
    });
    if (registryHit) {
      return { kind: "replayed" };
    }
    // New-period gate: grant only when the window's END advances beyond
    // every funded period (upgrade/proration: new event id, same window ->
    // no grant, no custody change; tier applies from the next funded
    // period). Gating on the period end — not the start — is what keeps
    // Google renewals fundable: their reported start (lifetime startTime)
    // never advances, while the expiry advances on every real renewal.
    const newerFunded = await tx.lineagePeriodCustody.findFirst({
      where: {
        lineageId: lineage.ctx.lineageId,
        periodEnd: { gte: lineage.periodEnd },
      },
      select: { id: true },
    });
    if (newerFunded) {
      return { kind: "replayed" };
    }
  }

  // Serialize same-account ledger writers BEFORE the pre-check (mirrors the lock
  // the forfeit path takes). Without it, two concurrent same-(sub, period)
  // grants both read `prior === null` and both reach `creditLedger.create`, so
  // the loser hits P2002 on (accountId, idempotencyKey) and aborts the whole tx.
  // Holding the UserCredits row lock makes the loser block until the winner
  // commits; its pre-check then sees the committed row and no-ops as "replayed".
  await lockUserCreditsBalance(tx, subscription.accountId);

  // Pre-check inside the tx so a same-period grant already committed by a
  // concurrent verify/notification no-ops instead of aborting the whole tx on
  // the unique-key violation.
  const prior = await findLedgerRow(tx, subscription.accountId, idempotencyKey);
  if (prior) {
    return { kind: "replayed" };
  }

  await applyDeltaWithTx(tx, {
    accountId: subscription.accountId,
    delta: BigInt(credits),
    reason: LedgerReason.grant,
    idempotencyKey,
    scope: "grant",
    grantKindId: "sub_grant",
    note: `subscription ${subscription.id} period ${periodStart.toISOString()}`,
  });

  if (lineage) {
    await tx.lineagePeriodGrant.create({
      data: {
        lineageId: lineage.ctx.lineageId,
        providerPeriodKey: lineage.providerPeriodKey,
        accountId: subscription.accountId,
        ledgerKey: idempotencyKey,
      },
    });
    await createHeldCustody(tx, lineage.ctx, {
      providerPeriodKey: lineage.providerPeriodKey,
      ownerAccountId: subscription.accountId,
      credits: BigInt(credits),
      periodStart: lineage.periodStart,
      periodEnd: lineage.periodEnd,
    });
  }

  return { kind: "granted", credits, subscription };
};

export type ForfeitSubscriptionPeriodResult =
  | { kind: "forfeited"; credits: number }
  | { kind: "replayed" }
  | { kind: "skipped_nothing_to_forfeit" };

/**
 * On expiry/refund/revoke, write ONE bounded `sub_forfeit` adjustment
 * that removes only the unused subscription portion of the passed period:
 *
 *   periodGrant    = the sub_grant delta we wrote for this period
 *   periodConsumes = |consume deltas| in [periodStart, consumesUntil)
 *   unusedSub      = max(0, periodGrant − periodConsumes)
 *   forfeitDelta   = −min(lockedBalance, unusedSub)        # clamp ≥ 0
 *
 * `consumesUntil` bounds the consume window to the ending period: renewal
 * callers pass the NEW period's start so spends made after the ending period are
 * not attributed to it (which would shrink this forfeit and let the wallet keep
 * more than one period's credits). The terminal (expiry) forfeit omits it — that
 * period has no successor, so all spends since its start are its own.
 *
 * The `min(lockedBalance, unusedSub)` clamp guarantees the forfeit never drives
 * the wallet below the admin/promo/signup credits sharing it, and never below
 * zero. CRITICAL: `lockedBalance` is read AFTER taking the row lock on
 * `UserCredits` (via `lockUserCreditsBalance`), so a consume committing
 * concurrently between our read and our write cannot make the clamp stale and
 * drive the wallet negative. A `floorCheck: { minBalance: 0n }` on the apply is
 * a belt-and-suspenders guard that throws (rather than silently writing a
 * negative balance) should the clamp ever be defeated. Idempotent on
 * `sub_forfeit:{subscription.id}:{periodStart epoch}` so a duplicate
 * EXPIRED/REVOKE webhook doesn't double-claw.
 *
 * Cancel-while-active (auto-renew off, period still running) must NOT call this
 * — the credits stay until the period ends.
 */
export const forfeitSubscriptionPeriod = async (
  tx: TxClient,
  args: { subscription: Subscription; periodStart: Date; consumesUntil?: Date },
): Promise<ForfeitSubscriptionPeriodResult> => {
  const { subscription, periodStart, consumesUntil } = args;
  const forfeitKey = subForfeitKey(subscription.id, periodStart);

  const priorForfeit = await findLedgerRow(
    tx,
    subscription.accountId,
    forfeitKey,
  );
  if (priorForfeit) {
    return { kind: "replayed" };
  }

  const grantKey = subGrantKey(subscription.id, periodStart);
  const periodGrant = await sumPeriodGrants(
    tx,
    subscription.accountId,
    grantKey,
  );
  if (periodGrant <= 0) {
    // Nothing was granted for this period (e.g. Option A never materialized it)
    // → nothing of ours to claw back.
    return { kind: "skipped_nothing_to_forfeit" };
  }

  // B1: take the row lock FIRST, then read both the period consumes and the
  // wallet balance under that lock. A plain unlocked `findUnique` here let a
  // consume commit between the balance read and the apply, so the precomputed
  // `−forfeit` delta could overshoot the (now smaller) locked base and drive the
  // wallet negative. Locking before we compute the clamp removes that window —
  // the balance we clamp against is the same one `applyDeltaWithTx` mutates.
  const lockedBalance = await lockUserCreditsBalance(
    tx,
    subscription.accountId,
  );

  const periodConsumes = await sumConsumesBetween(
    tx,
    subscription.accountId,
    periodStart,
    consumesUntil,
  );
  const unusedSub = Math.max(0, periodGrant - periodConsumes);
  if (unusedSub <= 0) {
    return { kind: "skipped_nothing_to_forfeit" };
  }

  const lockedPositive = lockedBalance > 0n ? Number(lockedBalance) : 0;
  const forfeit = Math.min(lockedPositive, unusedSub);
  if (forfeit <= 0) {
    return { kind: "skipped_nothing_to_forfeit" };
  }

  await applyDeltaWithTx(tx, {
    accountId: subscription.accountId,
    delta: BigInt(-forfeit),
    reason: LedgerReason.adjust,
    idempotencyKey: forfeitKey,
    scope: "sub_forfeit",
    grantKindId: "sub_forfeit",
    note: `subscription ${subscription.id} forfeit period ${periodStart.toISOString()}`,
    // Belt-and-suspenders: even though `forfeit` is clamped to the locked
    // balance, refuse to ever write a balance below zero.
    floorCheck: { minBalance: 0n },
  });

  return { kind: "forfeited", credits: forfeit };
};
