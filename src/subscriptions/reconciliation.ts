import { BillingProvider, SubscriptionStatus } from "@prisma/client";
import { getSubscriptionStatuses } from "@/subscriptions/apple-server-api";
import {
  CUSTODY_STATE_HELD,
  findCustody,
  findCustodyCovering,
  invalidateCustody,
} from "@/subscriptions/custody";
import { fetchSubscriptionPurchaseV2 } from "@/subscriptions/google-play/play-api";
import {
  deriveStatusFromPurchase,
  extractPeriodWindow,
  extractProductId,
} from "@/subscriptions/google-play/status";
import {
  LineageUnresolvedError,
  lockLineage,
  resolveOrCreateGoogleLineage,
} from "@/subscriptions/lineage";
import { productMapping } from "@/subscriptions/product-mapping";
import {
  applyNotification,
  compensateVoidedPurchase,
  type NotificationStateUpdate,
} from "@/subscriptions/repository";
import { withDeadlockRetry } from "@/utils/deadlock-retry";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Reclaim reconciliation sweep — the consumer for everything the online
 * paths fail closed into, plus a custody-versus-provider drift check.
 * Modeled on the deletion outbox drain (same tick, bounded batches,
 * idempotent re-runs, observable counts).
 *
 * Pass 1 — quarantine drain. LineageQuarantine rows are written by the
 * fail-closed paths (keyless verify/RTDN/claim events, keyless or unmatched
 * voids) and by the lineage resolver (chain conflicts). Retryable reasons
 * are re-driven against fresh provider state through the SAME hardened
 * code paths (atomic resolver, applyNotification with its receipt/registry
 * idempotency keys), so re-running the sweep never double-applies anything.
 * Conflict-class reasons are never auto-resolved (never auto-merge) — they
 * stay for an operator and are only counted.
 *
 * Pass 2 — post-transfer drift. Lineages with a committed transfer /
 * restore / undo inside the last 24 hours are re-checked against
 * authoritative provider state; a non-entitled result invalidates the
 * current held custody from the current owner (bounded, conservative move)
 * and raises an ops alert log. This is the v2-finding-9 sweep: webhook
 * compensation cannot close missing, delayed, or mis-ordered provider
 * events, and tombstone restorations never pass through the contest-window
 * settlement recheck.
 */

const QUARANTINE_BATCH = 25;
const DRIFT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DRIFT_BATCH = 50;

/** Reasons the sweep may retry against fresh provider state. */
const RETRYABLE_REASONS = new Set([
  "missing_latest_order_id",
  "voided_purchase_keyless",
  "voided_purchase_unmatched_order",
]);

/** Conflict-class reasons: operator-only, never auto-merged. */
const OPERATOR_REASONS = new Set([
  "alias_conflict_between_lineages",
  "alias_points_at_other_lineage",
  "chain_loop",
  "chain_depth_exceeded",
  "alias_race_exhausted",
  "tombstone_rotation_mismatch",
]);

export type ReconciliationCounts = {
  quarantineRecovered: number;
  quarantineDeferred: number;
  quarantineNeedsOperator: number;
  driftChecked: number;
  driftCompensated: number;
  driftDeferred: number;
};

const ENTITLED_APPLE_STATUSES = new Set([1, 4]);
const ENTITLED_STATUSES = new Set<SubscriptionStatus>([
  SubscriptionStatus.active,
  SubscriptionStatus.grace,
  SubscriptionStatus.trial,
]);

/**
 * Re-drive one parked Google token against fresh provider state through the
 * normal notification path. Returns true when the row's condition is
 * resolved (event applied or superseded), false to leave it parked.
 */
const reconcileGoogleToken = async (row: {
  id: string;
  token: string;
  reason: string;
  payload: unknown;
}): Promise<"recovered" | "deferred" | "needs_operator"> => {
  const purchase = await fetchSubscriptionPurchaseV2(row.token);
  if (!purchase.latestOrderId) {
    // Still keyless: nothing new to act on.
    return "deferred";
  }

  // Unmatched-order voids: only resolvable once the exact custody row
  // exists (e.g. after a legacy bootstrap); re-check by key and compensate
  // through the normal path — which no longer parks, since the row exists.
  if (row.reason === "voided_purchase_unmatched_order") {
    const payload =
      row.payload && typeof row.payload === "object"
        ? (row.payload as { orderId?: unknown })
        : {};
    const orderId =
      typeof payload.orderId === "string" ? payload.orderId : null;
    if (!orderId) return "needs_operator";
    const lineageId = await resolveOrCreateGoogleLineage({
      token: row.token,
      linkedPurchaseToken: purchase.linkedPurchaseToken,
    });
    const custody = await withDeadlockRetry(() =>
      prisma.$transaction(async (tx) => {
        const ctx = await lockLineage(tx, lineageId);
        return findCustody(tx, ctx, `play_order_${orderId}`);
      }),
    );
    if (!custody) return "deferred";
    const result = await compensateVoidedPurchase(row.token, orderId);
    return result.kind === "compensated" ? "recovered" : "deferred";
  }

  // Keyless funding/void events: the purchase now carries its order
  // identity — re-apply authoritative state through applyNotification (all
  // idempotency keys and gates apply; a tombstoned lineage funds escrow or
  // invalidates it; a live row grants/claws exactly once).
  const status = deriveStatusFromPurchase(purchase);
  const window = extractPeriodWindow(purchase);
  const productId = extractProductId(purchase);
  const { tier } = productMapping(productId);
  const entitled = ENTITLED_STATUSES.has(status);
  const update: NotificationStateUpdate = entitled
    ? {
        status,
        tier,
        productId,
        currentPeriodStart: window.currentPeriodStart,
        currentPeriodEnd: window.currentPeriodEnd,
        willRenew:
          purchase.lineItems?.[0]?.autoRenewingPlan?.autoRenewEnabled !== false,
      }
    : {
        status,
        currentPeriodEnd: window.currentPeriodEnd,
        willRenew: false,
        ...(status === SubscriptionStatus.revoked
          ? { cancelledAt: new Date() }
          : {}),
      };
  await applyNotification({
    provider: BillingProvider.googlePlay,
    purchaseToken: row.token,
    linkedPurchaseToken: purchase.linkedPurchaseToken ?? null,
    playOrderId: purchase.latestOrderId,
    // Stable per quarantine row: a re-run after a partial failure replays
    // idempotently through the receipt dedupe.
    messageId: `reconcile_${row.id}`,
    notificationType: "RECONCILE",
    notificationSubtype: null,
    signedPayload: JSON.stringify(purchase),
    update,
  });
  return "recovered";
};

const drainQuarantine = async (counts: ReconciliationCounts): Promise<void> => {
  const rows = await prisma.lineageQuarantine.findMany({
    where: { resolvedAt: null },
    orderBy: { createdAt: "asc" },
    take: QUARANTINE_BATCH,
  });
  for (const row of rows) {
    if (OPERATOR_REASONS.has(row.reason)) {
      counts.quarantineNeedsOperator += 1;
      continue;
    }
    if (!RETRYABLE_REASONS.has(row.reason)) {
      counts.quarantineNeedsOperator += 1;
      continue;
    }
    try {
      const outcome = await reconcileGoogleToken(row);
      if (outcome === "recovered") {
        await prisma.lineageQuarantine.update({
          where: { id: row.id },
          data: { resolvedAt: new Date() },
        });
        counts.quarantineRecovered += 1;
        logger.info(
          { quarantineId: row.id, reason: row.reason },
          "subscription.reconcile.quarantine_recovered",
        );
      } else if (outcome === "needs_operator") {
        counts.quarantineNeedsOperator += 1;
      } else {
        counts.quarantineDeferred += 1;
      }
    } catch (err) {
      if (err instanceof LineageUnresolvedError) {
        // The resolver quarantined the conflict under its own row; this
        // row's disposition is now that conflict — resolve it to stop
        // re-spawning duplicates every sweep.
        await prisma.lineageQuarantine.update({
          where: { id: row.id },
          data: { resolvedAt: new Date() },
        });
        counts.quarantineNeedsOperator += 1;
        continue;
      }
      counts.quarantineDeferred += 1;
      logger.warn(
        { err, quarantineId: row.id, reason: row.reason },
        "subscription.reconcile.quarantine_deferred",
      );
    }
  }
};

/** Provider-authoritative entitlement for one live subscription row. */
const checkEntitlement = async (row: {
  provider: BillingProvider;
  originalTransactionId: string | null;
  purchaseToken: string | null;
}): Promise<"entitled" | "not_entitled" | "unknown"> => {
  try {
    if (row.provider === BillingProvider.apple) {
      if (!row.originalTransactionId) return "unknown";
      const statuses = await getSubscriptionStatuses(row.originalTransactionId);
      for (const group of statuses.data ?? []) {
        for (const item of group.lastTransactions ?? []) {
          if (
            item.originalTransactionId === row.originalTransactionId &&
            item.status !== undefined &&
            ENTITLED_APPLE_STATUSES.has(item.status)
          ) {
            return "entitled";
          }
        }
      }
      return "not_entitled";
    }
    if (!row.purchaseToken) return "unknown";
    const purchase = await fetchSubscriptionPurchaseV2(row.purchaseToken);
    const status = deriveStatusFromPurchase(purchase);
    return ENTITLED_STATUSES.has(status) ? "entitled" : "not_entitled";
  } catch (err) {
    logger.warn({ err }, "subscription.reconcile.entitlement_check_failed");
    return "unknown";
  }
};

const sweepTransferDrift = async (
  counts: ReconciliationCounts,
): Promise<void> => {
  const recent = await prisma.subscriptionTransfer.findMany({
    where: {
      status: "committed",
      kind: { in: ["transfer", "restore", "undo"] },
      createdAt: { gte: new Date(Date.now() - DRIFT_LOOKBACK_MS) },
    },
    select: { lineageId: true },
    distinct: ["lineageId"],
    take: DRIFT_BATCH,
  });
  for (const { lineageId } of recent) {
    const row = await prisma.subscription.findFirst({ where: { lineageId } });
    if (!row) continue;
    counts.driftChecked += 1;
    const entitlement = await checkEntitlement(row);
    if (entitlement === "unknown") {
      counts.driftDeferred += 1;
      continue;
    }
    if (entitlement === "entitled") continue;
    // Provider says the recently transferred/restored subscription is no
    // longer entitled: claw the conservative remainder from the current
    // holder (idempotent — a second pass finds no held custody covering
    // now). The webhook, when it arrives, replays as a no-op.
    const compensated = await withDeadlockRetry(
      () =>
        prisma.$transaction(async (tx) => {
          const ctx = await lockLineage(tx, lineageId);
          const custody = await findCustodyCovering(tx, ctx, new Date(), [
            CUSTODY_STATE_HELD,
          ]);
          // Already settled (a prior sweep or the webhook invalidated it):
          // nothing further to claw — idempotent re-run.
          if (!custody) return null;
          return invalidateCustody(tx, ctx, {
            custody,
            journalId: custody.id,
          });
        }),
      { label: "reconcile_drift_compensation" },
    );
    if (compensated === null) continue;
    counts.driftCompensated += 1;
    // Ops alert: a post-transfer entitlement mismatch is page-worthy.
    logger.error(
      { lineageId, compensated: compensated.toString() },
      "subscription.reconcile.drift_compensated",
    );
  }
};

export const runReclaimReconciliationSweep =
  async (): Promise<ReconciliationCounts> => {
    const counts: ReconciliationCounts = {
      quarantineRecovered: 0,
      quarantineDeferred: 0,
      quarantineNeedsOperator: 0,
      driftChecked: 0,
      driftCompensated: 0,
      driftDeferred: 0,
    };
    await drainQuarantine(counts);
    await sweepTransferDrift(counts);
    const total =
      counts.quarantineRecovered +
      counts.quarantineDeferred +
      counts.quarantineNeedsOperator +
      counts.driftChecked;
    if (total > 0) {
      logger.info(counts, "subscription.reconcile.sweep_completed");
    }
    return counts;
  };
