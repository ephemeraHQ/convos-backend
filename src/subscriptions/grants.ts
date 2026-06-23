import { LedgerReason, type Prisma, type Subscription } from "@prisma/client";
import { applyDeltaWithTx } from "@/payments/ledger";
import { tierGrant } from "@/subscriptions/tier-config";
import { requireSubscriptionTier } from "@/subscriptions/tiers";

type TxClient = Prisma.TransactionClient;

/**
 * Single-ledger subscription money-in / money-out.
 *
 * Subscriptions are no longer derived at read time — subscribe + each renewal
 * write a real `sub_grant` credit row into the one wallet (`UserCredits`), and
 * expiry/refund/revoke write a bounded `subscription_forfeit` adjustment that
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

const sumConsumesSince = async (
  tx: TxClient,
  accountId: string,
  since: Date,
): Promise<number> => {
  const agg = await tx.creditLedger.aggregate({
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
 * Write the per-period subscription allotment as a real `grant` ledger row,
 * idempotent on `sub_grant:{subscription.id}:{periodStartEpoch}`. Safe to call
 * from the verify path and the renewal-notification path; a webhook retry, an
 * Apple S2S DID_RENEW racing the iOS /verify for the same period, or a
 * re-verify all resolve to the same key and no-op.
 *
 * Runs inside the caller's transaction. The key is derived from the internal
 * stable `subscription.id` (NOT a provider token — Play rotates purchaseToken).
 */
export const grantSubscriptionPeriod = async (
  tx: TxClient,
  args: { subscription: Subscription; periodStart: Date },
): Promise<GrantSubscriptionPeriodResult> => {
  const { subscription, periodStart } = args;
  const credits = tierGrant(
    requireSubscriptionTier(subscription.tier),
    subscription.period,
  ).perPeriod;
  if (credits <= 0) {
    return { kind: "skipped_nonpositive" };
  }

  const idempotencyKey = subGrantKey(subscription.id, periodStart);

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

  const updated = await tx.subscription.update({
    where: { id: subscription.id },
    data: { lastGrantedPeriodStart: periodStart },
  });

  return { kind: "granted", credits, subscription: updated };
};

export type ForfeitSubscriptionPeriodResult =
  | { kind: "forfeited"; credits: number }
  | { kind: "replayed" }
  | { kind: "skipped_nothing_to_forfeit" };

/**
 * On expiry/refund/revoke, write ONE bounded `subscription_forfeit` adjustment
 * that removes only the unused subscription portion of the current period:
 *
 *   periodGrant    = the sub_grant delta we wrote for this period
 *   periodConsumes = |consume deltas| since currentPeriodStart
 *   unusedSub      = max(0, periodGrant − periodConsumes)
 *   forfeitDelta   = −min(walletBalance, unusedSub)        # clamp ≥ 0
 *
 * The `min(walletBalance, unusedSub)` clamp guarantees the forfeit never drives
 * the wallet below the admin/promo/signup credits sharing it, and never below
 * zero. Idempotent on `sub_forfeit:{subscription.id}:{periodStartEpoch}` so a
 * duplicate EXPIRED/REVOKE webhook doesn't double-claw.
 *
 * Cancel-while-active (auto-renew off, period still running) must NOT call this
 * — the credits stay until the period ends.
 */
export const forfeitSubscriptionPeriod = async (
  tx: TxClient,
  args: { subscription: Subscription },
): Promise<ForfeitSubscriptionPeriodResult> => {
  const { subscription } = args;
  const periodStart = subscription.currentPeriodStart;
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

  const periodConsumes = await sumConsumesSince(
    tx,
    subscription.accountId,
    periodStart,
  );
  const unusedSub = Math.max(0, periodGrant - periodConsumes);
  if (unusedSub <= 0) {
    return { kind: "skipped_nothing_to_forfeit" };
  }

  const walletRow = await tx.userCredits.findUnique({
    where: { accountId: subscription.accountId },
    select: { balance: true },
  });
  const walletBalance = walletRow?.balance ?? 0n;
  const walletPositive = walletBalance > 0n ? Number(walletBalance) : 0;

  const forfeit = Math.min(walletPositive, unusedSub);
  if (forfeit <= 0) {
    return { kind: "skipped_nothing_to_forfeit" };
  }

  await applyDeltaWithTx(tx, {
    accountId: subscription.accountId,
    delta: BigInt(-forfeit),
    reason: LedgerReason.adjust,
    idempotencyKey: forfeitKey,
    scope: "subscription_forfeit",
    grantKindId: "subscription_forfeit",
    note: `subscription ${subscription.id} forfeit period ${periodStart.toISOString()}`,
  });

  return { kind: "forfeited", credits: forfeit };
};
