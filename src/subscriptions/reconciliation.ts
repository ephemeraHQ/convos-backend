import {
  BillingProvider,
  SubscriptionStatus,
  type Subscription,
} from "@prisma/client";
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
 * idempotent re-runs, observable counts). The whole sweep runs under a
 * Postgres advisory lock (single runner across replicas — provider calls
 * are not duplicated; a lost lease degrades to idempotent re-runs).
 *
 * Pass 1 — quarantine drain. LineageQuarantine rows are written by the
 * fail-closed paths (keyless verify/RTDN/claim events, keyless or unmatched
 * voids, restorations missing their funding event) and by the lineage
 * resolver (chain conflicts). Retryable reasons are re-driven against fresh
 * provider state through the SAME hardened code paths (atomic resolver,
 * applyNotification with its receipt/registry idempotency keys), so
 * re-running the sweep never double-applies anything. Every row carries its
 * own retry state (attempts + nextAttemptAt backoff): a persistent row backs
 * off and eventually escalates to an operator instead of occupying the batch
 * forever, so newer recoverable rows are never starved. Conflict-class
 * reasons are never auto-resolved (never auto-merge) — they stay for an
 * operator and are only counted.
 *
 * Pass 2 — post-transfer drift. Lineages with a committed transfer /
 * restore / undo are re-checked against authoritative provider state for the
 * full 24 hours after commit. A database trigger creates or extends one
 * durable schedule per lineage; each entitled answer schedules another
 * periodic check, while provider failures back off only that lineage and
 * eventually escalate it to an operator. Due rows are served most-overdue
 * first, so sustained new volume and one unavailable provider lineage cannot
 * starve the rest of the monitoring window. A non-entitled answer invalidates
 * the affected held custody (current-window or, when the period just ended,
 * the latest held row) and writes the provider-derived terminal state onto
 * the Subscription row — but only after re-reading the row under the lineage
 * lock and fencing on its version: a renewal that landed between the provider
 * fetch and the lock must never be clawed with the stale answer.
 */

const QUARANTINE_BATCH = 25;
/** Retries before a quarantine row escalates to an operator. */
const QUARANTINE_MAX_ATTEMPTS = 10;
const QUARANTINE_BACKOFF_BASE_MS = 60 * 60 * 1000;
const QUARANTINE_BACKOFF_MAX_MS = 7 * 24 * 60 * 60 * 1000;

const DRIFT_BATCH = 50;
/** Provider-check work stays bounded while each tick drains multiple pages. */
const DRIFT_MAX_PER_SWEEP = 3 * DRIFT_BATCH;
/** Every committed lineage remains in periodic drift review for this window. */
const DRIFT_MONITOR_WINDOW_MS = 24 * 60 * 60 * 1000;
const DRIFT_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Same retry budget/formula as quarantine, tuned to fit the 24h window. */
const DRIFT_MAX_ATTEMPTS = 10;
const DRIFT_BACKOFF_BASE_MS = 5 * 60 * 1000;
const DRIFT_BACKOFF_MAX_MS = 60 * 60 * 1000;
/**
 * DB-stamped rows become visible only at commit. A fresh row may be checked
 * idempotently, but its next periodic check is not advanced past this margin.
 */
const DRIFT_COMMIT_VISIBILITY_MS = 2 * 60 * 1000;

/**
 * Single-runner lease in Postgres's two-int advisory-lock namespace. That
 * namespace is structurally disjoint from the identity barrier's one-bigint
 * hash locks; class id 7_281 is reserved for subsystem leases.
 */
const SWEEP_ADVISORY_LOCK_CLASS_ID = 7_281;
const SWEEP_ADVISORY_LOCK_OBJECT_ID = 93_642;
const SWEEP_LEASE_TIMEOUT_MS = 10 * 60 * 1000;

/** Reasons the sweep may retry against fresh provider state. */
const RETRYABLE_REASONS = [
  "missing_latest_order_id",
  "voided_purchase_keyless",
  "voided_purchase_unmatched_order",
];

export type ReconciliationCounts = {
  leaseAcquired: boolean;
  quarantineRecovered: number;
  quarantineDeferred: number;
  quarantineNeedsOperator: number;
  driftChecked: number;
  driftCompensated: number;
  driftDeferred: number;
  driftDeadlineChecks: number;
  driftBacklogRemaining: number;
};

const ENTITLED_APPLE_STATUSES = new Set([1, 4]);
const ENTITLED_STATUSES = new Set<SubscriptionStatus>([
  SubscriptionStatus.active,
  SubscriptionStatus.grace,
  SubscriptionStatus.trial,
]);

type QuarantineRow = {
  id: string;
  token: string;
  reason: string;
  payload: unknown;
  attempts: number;
};

/**
 * Re-drive one parked Google token against fresh provider state through the
 * normal notification path. Returns "recovered" when the row's condition is
 * resolved (event applied or superseded), "deferred" to retry after backoff,
 * "needs_operator" when fresh provider state can never resolve it.
 */
const reconcileGoogleToken = async (
  row: QuarantineRow,
): Promise<"recovered" | "deferred" | "needs_operator"> => {
  const purchase = await fetchSubscriptionPurchaseV2(row.token);
  if (!purchase.latestOrderId) {
    // Still keyless: nothing new to act on.
    return "deferred";
  }
  const status = deriveStatusFromPurchase(purchase);
  const entitled = ENTITLED_STATUSES.has(status);

  // Keyless voids: the void notification named no order. Fresh state
  // resolves it only when the subscription itself is no longer entitled —
  // the void hit the current order and the generic terminal path below
  // applies state + compensation. While the subscription stays entitled the
  // voided order is historical and current state cannot identify it: that
  // is an operator's call, never a silent "recovered".
  if (row.reason === "voided_purchase_keyless" && entitled) {
    return "needs_operator";
  }

  // Unmatched-order voids: resolvable once the exact custody row exists
  // (e.g. after a legacy bootstrap); re-check by key and compensate through
  // the normal path — which no longer parks, since the row exists.
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
    if (custody) {
      const result = await compensateVoidedPurchase(row.token, orderId);
      return result.kind === "compensated" ? "recovered" : "deferred";
    }
    // No exact custody row (a legacy period holds a legacy_ key no void can
    // name). When the voided order is the CURRENT latest order and the
    // subscription is no longer entitled, the generic terminal path below
    // resolves it — applyNotification's clawback falls back to the legacy
    // window row. Anything else stays parked (and escalates after enough
    // attempts) rather than guessing which period to claw.
    if (orderId !== purchase.latestOrderId || entitled) {
      return "deferred";
    }
  }

  // Keyless funding/void events: the purchase now carries its order
  // identity — re-apply authoritative state through applyNotification (all
  // idempotency keys and gates apply; a tombstoned lineage funds escrow or
  // invalidates it; a live row grants/claws exactly once). Terminal updates
  // omit currentPeriodEnd: the provider truncates the reported window to
  // the revocation time, which the staleness guard would misread as an
  // out-of-order event and skip the state-apply (and its clawback).
  const window = extractPeriodWindow(purchase);
  const productId = extractProductId(purchase);
  const { tier } = productMapping(productId);
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

const quarantineBackoffMs = (attempts: number): number => {
  const exp = QUARANTINE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, QUARANTINE_BACKOFF_MAX_MS);
};

/** Defer with backoff; escalate to an operator once retries are exhausted. */
const deferQuarantineRow = async (
  row: QuarantineRow,
  counts: ReconciliationCounts,
): Promise<void> => {
  const attempts = row.attempts + 1;
  if (attempts >= QUARANTINE_MAX_ATTEMPTS) {
    await escalateQuarantineRow(row, counts, "retries_exhausted");
    return;
  }
  await prisma.lineageQuarantine.update({
    where: { id: row.id },
    data: {
      attempts,
      nextAttemptAt: new Date(Date.now() + quarantineBackoffMs(attempts)),
    },
  });
  counts.quarantineDeferred += 1;
};

const escalateQuarantineRow = async (
  row: QuarantineRow,
  counts: ReconciliationCounts,
  cause: string,
): Promise<void> => {
  await prisma.lineageQuarantine.update({
    where: { id: row.id },
    data: { attempts: row.attempts + 1, needsOperatorAt: new Date() },
  });
  counts.quarantineNeedsOperator += 1;
  // Ops alert: the sweep has given up on auto-resolving this row.
  logger.error(
    { quarantineId: row.id, reason: row.reason, cause },
    "subscription.reconcile.quarantine_escalated",
  );
};

const drainQuarantine = async (counts: ReconciliationCounts): Promise<void> => {
  // Standing operator queue (counted before the batch so rows escalated in
  // this run are not double-counted): unresolved rows the retry batch will
  // never pick — conflict-class reasons, unknown reasons, escalated rows.
  counts.quarantineNeedsOperator += await prisma.lineageQuarantine.count({
    where: {
      resolvedAt: null,
      OR: [
        { reason: { notIn: RETRYABLE_REASONS } },
        { needsOperatorAt: { not: null } },
      ],
    },
  });
  // Only rows the sweep can act on enter the batch: retryable reasons, due
  // for their next attempt, not escalated. Conflict-class and other
  // operator-only rows are excluded here — they can never occupy (let alone
  // exhaust) the batch.
  const rows = await prisma.lineageQuarantine.findMany({
    where: {
      resolvedAt: null,
      needsOperatorAt: null,
      reason: { in: RETRYABLE_REASONS },
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: { nextAttemptAt: "asc" },
    take: QUARANTINE_BATCH,
  });
  for (const row of rows) {
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
        await escalateQuarantineRow(row, counts, "unresolvable_from_provider");
      } else {
        await deferQuarantineRow(row, counts);
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
      await deferQuarantineRow(row, counts);
      logger.warn(
        { err, quarantineId: row.id, reason: row.reason },
        "subscription.reconcile.quarantine_deferred",
      );
    }
  }
};

type DriftCheck =
  | { verdict: "entitled" }
  | { verdict: "unknown" }
  | { verdict: "not_entitled"; terminalStatus: SubscriptionStatus };

type DriftCheckOutcome = "entitled" | "settled" | "deferred";

/** Provider-authoritative entitlement for one live subscription row. */
const checkEntitlement = async (row: {
  provider: BillingProvider;
  originalTransactionId: string | null;
  purchaseToken: string | null;
}): Promise<DriftCheck> => {
  try {
    if (row.provider === BillingProvider.apple) {
      if (!row.originalTransactionId) return { verdict: "unknown" };
      const statuses = await getSubscriptionStatuses(row.originalTransactionId);
      for (const group of statuses.data ?? []) {
        for (const item of group.lastTransactions ?? []) {
          if (
            item.originalTransactionId === row.originalTransactionId &&
            item.status !== undefined &&
            ENTITLED_APPLE_STATUSES.has(item.status)
          ) {
            return { verdict: "entitled" };
          }
        }
      }
      // The status API does not distinguish refund from natural expiry
      // here; expired is the conservative terminal state either way (the
      // custody clawback is identical).
      return {
        verdict: "not_entitled",
        terminalStatus: SubscriptionStatus.expired,
      };
    }
    if (!row.purchaseToken) return { verdict: "unknown" };
    const purchase = await fetchSubscriptionPurchaseV2(row.purchaseToken);
    const status = deriveStatusFromPurchase(purchase);
    if (ENTITLED_STATUSES.has(status)) return { verdict: "entitled" };
    return { verdict: "not_entitled", terminalStatus: status };
  } catch (err) {
    logger.warn({ err }, "subscription.reconcile.entitlement_check_failed");
    return { verdict: "unknown" };
  }
};

/**
 * Version fence material captured before the provider call. The clawback
 * transaction re-reads the row under the lineage lock and applies the
 * provider verdict only if the row is byte-identical on identity and
 * version — a concurrent renewal/claim/webhook makes the verdict stale.
 */
type DriftSnapshot = Pick<
  Subscription,
  | "id"
  | "provider"
  | "originalTransactionId"
  | "purchaseToken"
  | "currentPeriodEnd"
  | "updatedAt"
>;

const driftFenceHolds = (
  snapshot: DriftSnapshot,
  current: Subscription,
): boolean =>
  current.updatedAt.getTime() === snapshot.updatedAt.getTime() &&
  current.purchaseToken === snapshot.purchaseToken &&
  current.originalTransactionId === snapshot.originalTransactionId &&
  current.currentPeriodEnd.getTime() === snapshot.currentPeriodEnd.getTime();

/**
 * Re-check one lineage against provider truth. Scheduling is deliberately
 * outside this function: the cleared compensation transaction returns only
 * the disposition the lineage's durable schedule needs.
 */
const checkLineageDrift = async (
  lineageId: string,
  counts: ReconciliationCounts,
): Promise<DriftCheckOutcome> => {
  const snapshot = await prisma.subscription.findFirst({
    where: { lineageId },
  });
  if (!snapshot) {
    // No live row: the lineage tombstoned (escrow/teardown paths own it) or
    // the row was torn down — nothing to drift-check.
    return "settled";
  }
  counts.driftChecked += 1;
  const check = await checkEntitlement(snapshot);
  if (check.verdict === "unknown") {
    return "deferred";
  }
  if (check.verdict === "entitled") return "entitled";
  const { terminalStatus } = check;
  // Provider says the recently transferred/restored subscription is no
  // longer entitled: claw the conservative remainder from the current
  // holder (idempotent — a second pass finds no held custody) and write the
  // provider-derived terminal state on the row. Both happen under the
  // lineage lock behind the version fence.
  const outcome = await withDeadlockRetry(
    () =>
      prisma.$transaction(
        async (tx) => {
          const ctx = await lockLineage(tx, lineageId);
          const current = await tx.subscription.findUnique({
            where: { id: snapshot.id },
          });
          if (!current) return { kind: "settled" as const, compensated: null };
          if (!driftFenceHolds(snapshot, current)) {
            // The row changed between the provider fetch and the lock (a
            // renewal webhook advancing the window, a claim re-homing the
            // row, ...). The verdict is stale: defer and re-fetch next
            // sweep. A renewed period is never invalidated on a stale read.
            return { kind: "fenced" as const };
          }
          await tx.subscription.update({
            where: { id: current.id },
            data: {
              status: terminalStatus,
              willRenew: false,
              ...(terminalStatus === SubscriptionStatus.revoked
                ? { cancelledAt: new Date() }
                : {}),
            },
          });
          // The affected period's custody: the row covering now or — when
          // the period ended just before this sweep (lost terminal event) —
          // the latest held row. Covering-now alone would let a
          // just-expired period keep its unspent value forever.
          const custody =
            (await findCustodyCovering(tx, ctx, new Date(), [
              CUSTODY_STATE_HELD,
            ])) ??
            (await tx.lineagePeriodCustody.findFirst({
              where: { lineageId, state: CUSTODY_STATE_HELD },
              orderBy: { periodEnd: "desc" },
            }));
          // Already settled (a prior sweep or the webhook invalidated it):
          // nothing further to claw — idempotent re-run.
          if (!custody) return { kind: "settled" as const, compensated: null };
          const moved = await invalidateCustody(tx, ctx, {
            custody,
            journalId: custody.id,
          });
          return { kind: "settled" as const, compensated: moved };
        },
        { timeout: 30_000 },
      ),
    { label: "reconcile_drift_compensation" },
  );
  if (outcome.kind === "fenced") {
    return "deferred";
  }
  if (outcome.compensated !== null) {
    counts.driftCompensated += 1;
    // Ops alert: a post-transfer entitlement mismatch is page-worthy.
    logger.error(
      {
        lineageId,
        compensated: outcome.compensated.toString(),
      },
      "subscription.reconcile.drift_compensated",
    );
  }
  return "settled";
};

type DriftScheduleRow = {
  lineageId: string;
  nextDriftCheckAt: Date;
  monitorUntil: Date;
  attempts: number;
};

const driftBackoffMs = (attempts: number): number => {
  const exp = DRIFT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, DRIFT_BACKOFF_MAX_MS);
};

const getDatabaseNow = async (): Promise<Date> => {
  const rows = await prisma.$queryRaw<{ now: Date }[]>`
    SELECT clock_timestamp() AS now
  `;
  return rows[0].now;
};

/** Mark a terminal/no-longer-applicable lineage complete for this window. */
const resolveDriftSchedule = async (
  schedule: DriftScheduleRow,
  now: Date,
): Promise<void> => {
  await prisma.subscriptionDriftSchedule.updateMany({
    where: {
      lineageId: schedule.lineageId,
      monitorUntil: schedule.monitorUntil,
      resolvedAt: null,
      needsOperatorAt: null,
    },
    data: { attempts: 0, resolvedAt: now },
  });
};

/** An entitled answer remains scheduled until the lineage's union deadline. */
const rescheduleEntitledDrift = async (
  schedule: DriftScheduleRow,
  now: Date,
): Promise<void> => {
  const nowMs = now.getTime();
  const visibilityReadyAt =
    schedule.monitorUntil.getTime() -
    DRIFT_MONITOR_WINDOW_MS +
    DRIFT_COMMIT_VISIBILITY_MS;
  const periodicAt = Math.max(
    nowMs + DRIFT_CHECK_INTERVAL_MS,
    visibilityReadyAt > nowMs ? visibilityReadyAt : 0,
  );
  const nextDriftCheckAt = new Date(
    Math.min(periodicAt, schedule.monitorUntil.getTime() - 1),
  );
  await prisma.subscriptionDriftSchedule.updateMany({
    where: {
      lineageId: schedule.lineageId,
      monitorUntil: schedule.monitorUntil,
      resolvedAt: null,
      needsOperatorAt: null,
    },
    data: { attempts: 0, nextDriftCheckAt },
  });
};

/** Back off only this lineage; after ten failures an operator owns it. */
const deferDriftSchedule = async (
  schedule: DriftScheduleRow,
  now: Date,
): Promise<void> => {
  const attempts = schedule.attempts + 1;
  const deadlineReached = schedule.monitorUntil.getTime() <= now.getTime();
  if (deadlineReached || attempts >= DRIFT_MAX_ATTEMPTS) {
    const result = await prisma.subscriptionDriftSchedule.updateMany({
      where: {
        lineageId: schedule.lineageId,
        monitorUntil: schedule.monitorUntil,
        resolvedAt: null,
        needsOperatorAt: null,
      },
      data: { attempts, needsOperatorAt: now },
    });
    if (result.count > 0) {
      logger.error(
        { lineageId: schedule.lineageId, attempts, deadlineReached },
        "subscription.reconcile.drift_escalated",
      );
    }
    return;
  }
  const nextDriftCheckAt = new Date(
    Math.min(
      now.getTime() + driftBackoffMs(attempts),
      schedule.monitorUntil.getTime() - 1,
    ),
  );
  await prisma.subscriptionDriftSchedule.updateMany({
    where: {
      lineageId: schedule.lineageId,
      monitorUntil: schedule.monitorUntil,
      resolvedAt: null,
      needsOperatorAt: null,
    },
    data: { attempts, nextDriftCheckAt },
  });
};

/** Apply one provider result without duplicating deadline dispositions. */
const processDriftSchedule = async (
  schedule: DriftScheduleRow,
  counts: ReconciliationCounts,
  now: Date,
  atDeadline: boolean,
): Promise<void> => {
  if (atDeadline) counts.driftDeadlineChecks += 1;
  let outcome: DriftCheckOutcome;
  try {
    outcome = await checkLineageDrift(schedule.lineageId, counts);
  } catch (err) {
    outcome = "deferred";
    logger.warn(
      { err, lineageId: schedule.lineageId },
      "subscription.reconcile.drift_check_failed",
    );
  }
  if (outcome === "entitled") {
    // A successful final provider answer closes the completed monitoring
    // window; periodic answers remain scheduled until that final check.
    if (atDeadline) {
      await resolveDriftSchedule(schedule, now);
    } else {
      await rescheduleEntitledDrift(schedule, now);
    }
  } else if (outcome === "settled") {
    await resolveDriftSchedule(schedule, now);
  } else {
    counts.driftDeferred += 1;
    // At the deadline there is no valid retry slot. The deadline-aware
    // defer helper escalates immediately instead of silently resolving.
    await deferDriftSchedule(schedule, now);
  }
};

const drainDriftSchedules = async (
  counts: ReconciliationCounts,
  now: Date,
  atDeadline: boolean,
  limit: number,
): Promise<number> => {
  let processed = 0;
  while (processed < limit) {
    const take = Math.min(DRIFT_BATCH, limit - processed);
    const schedules = atDeadline
      ? await prisma.subscriptionDriftSchedule.findMany({
          where: {
            resolvedAt: null,
            needsOperatorAt: null,
            monitorUntil: { lte: now },
          },
          orderBy: [{ monitorUntil: "asc" }, { lineageId: "asc" }],
          take,
          select: {
            lineageId: true,
            nextDriftCheckAt: true,
            monitorUntil: true,
            attempts: true,
          },
        })
      : await prisma.subscriptionDriftSchedule.findMany({
          where: {
            resolvedAt: null,
            needsOperatorAt: null,
            nextDriftCheckAt: { lte: now },
            monitorUntil: { gt: now },
          },
          orderBy: [{ nextDriftCheckAt: "asc" }, { lineageId: "asc" }],
          take,
          select: {
            lineageId: true,
            nextDriftCheckAt: true,
            monitorUntil: true,
            attempts: true,
          },
        });
    for (const schedule of schedules) {
      await processDriftSchedule(schedule, counts, now, atDeadline);
    }
    processed += schedules.length;
    if (schedules.length < take) break;
  }
  return processed;
};

const sweepTransferDrift = async (
  counts: ReconciliationCounts,
): Promise<void> => {
  // Every window/due calculation in this tick shares the database clock that
  // stamped committedAt; a fast application replica cannot age work out.
  const now = await getDatabaseNow();
  const deadlineProcessed = await drainDriftSchedules(
    counts,
    now,
    true,
    DRIFT_MAX_PER_SWEEP,
  );
  const remainingCapacity = DRIFT_MAX_PER_SWEEP - deadlineProcessed;
  if (remainingCapacity > 0) {
    await drainDriftSchedules(counts, now, false, remainingCapacity);
  }
  counts.driftBacklogRemaining = await prisma.subscriptionDriftSchedule.count({
    where: {
      resolvedAt: null,
      needsOperatorAt: null,
      OR: [
        { monitorUntil: { lte: now } },
        {
          nextDriftCheckAt: { lte: now },
          monitorUntil: { gt: now },
        },
      ],
    },
  });
  if (counts.driftDeadlineChecks > 0) {
    logger.warn(
      { deadlineChecks: counts.driftDeadlineChecks },
      "subscription.reconcile.drift_deadline_checked",
    );
  }
  if (counts.driftBacklogRemaining > 0) {
    logger.warn(
      {
        remaining: counts.driftBacklogRemaining,
        workCap: DRIFT_MAX_PER_SWEEP,
      },
      "subscription.reconcile.drift_backlog_remaining",
    );
  }
};

export const runReclaimReconciliationSweep =
  async (): Promise<ReconciliationCounts> => {
    const counts: ReconciliationCounts = {
      leaseAcquired: false,
      quarantineRecovered: 0,
      quarantineDeferred: 0,
      quarantineNeedsOperator: 0,
      driftChecked: 0,
      driftCompensated: 0,
      driftDeferred: 0,
      driftDeadlineChecks: 0,
      driftBacklogRemaining: 0,
    };
    // Single-runner lease: the transaction exists only to hold the advisory
    // lock while the sweep works on ordinary pooled connections. Replicas
    // that fail the try-lock skip this interval (the holder is doing the
    // work). If the lease transaction times out mid-sweep the lock releases
    // early and another replica may overlap — every sweep operation is
    // idempotent, so overlap only costs duplicate provider calls.
    await prisma.$transaction(
      async (tx) => {
        const lockRows = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(
            ${SWEEP_ADVISORY_LOCK_CLASS_ID}::int,
            ${SWEEP_ADVISORY_LOCK_OBJECT_ID}::int
          ) AS locked
        `;
        if (!lockRows[0]?.locked) {
          logger.info("subscription.reconcile.lease_held_elsewhere");
          return;
        }
        counts.leaseAcquired = true;
        await drainQuarantine(counts);
        await sweepTransferDrift(counts);
      },
      { timeout: SWEEP_LEASE_TIMEOUT_MS, maxWait: 5_000 },
    );
    const total =
      counts.quarantineRecovered +
      counts.quarantineDeferred +
      counts.quarantineNeedsOperator +
      counts.driftChecked +
      counts.driftDeadlineChecks +
      counts.driftBacklogRemaining;
    if (total > 0) {
      logger.info(counts, "subscription.reconcile.sweep_completed");
    }
    return counts;
  };
