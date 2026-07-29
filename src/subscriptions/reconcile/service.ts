import {
  Status as AppleSubscriptionStatus,
  type Environment,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import { SubscriptionStatus } from "@prisma/client";
import { writeAdminAudit } from "@/api/v2/credits-admin/audit-repository";
import { getSubscriptionStatusesWithEnvironmentFallback } from "@/subscriptions/apple-server-api";
import {
  forfeitSubscriptionPeriod,
  grantSubscriptionPeriod,
  subGrantKey,
  type ForfeitSubscriptionPeriodResult,
  type GrantSubscriptionPeriodResult,
} from "@/subscriptions/grants";
import {
  verifyAndDecodeRenewalInfo,
  verifyAndDecodeTransaction,
} from "@/subscriptions/jws-verifier";
import {
  findAppleByOriginalTransactionId,
  type NotificationStateUpdate,
  type Subscription,
} from "@/subscriptions/repository";
import {
  deriveSubscriptionStatusFromTransaction,
  isEntitledSubscription,
  isEntitledSubscriptionStatus,
} from "@/subscriptions/status";
import { tierGrant } from "@/subscriptions/tier-config";
import { requireSubscriptionTier } from "@/subscriptions/tiers";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Apple subscription reconcile — ALLOWLIST PILOT.
 *
 * Prod received zero App Store Server Notifications from launch until
 * 2026-07-29 (no Production Server URL was registered in App Store Connect),
 * so Subscription rows are frozen at their last client verify: statuses stay
 * `active` past `currentPeriodEnd`, EXPIRED/REFUND events were never applied,
 * and renewal re-grants only ever arrived via app-open re-verifies. This job
 * re-fetches PROVIDER GROUND TRUTH per subscription and refreshes the local
 * row — the repair path for that drift class.
 *
 * PILOT SCOPE — deliberately narrow:
 *   - Allowlist input only: explicit `originalTransactionId`s, resolved to
 *     Subscription rows one by one. There is NO fleet scan and NO cron mode in
 *     this module yet; the at-risk/rescue scan machinery exists on the
 *     unmerged branch `louis/credits-reconcile-cron` (commit 2b0b041), from
 *     which this module's Apple mapping and write-guards are ported, and gets
 *     resurrected when the job is promoted from pilot to safety net.
 *   - Apple only (both pilot rows are Apple). The Google path also lives in
 *     2b0b041.
 *   - DRY-RUN by default: the job reports intended changes and writes nothing.
 *     `apply: true` executes.
 *
 * Provider truth, not transaction expiry (ported from 2b0b041):
 *   Liveness comes from the per-item `status` enum on
 *   `getAllSubscriptionStatuses` (1 active / 2 expired / 3 billing-retry /
 *   4 grace / 5 revoked) PLUS the decoded `signedRenewalInfo`
 *   (`gracePeriodExpiresDate`). The transaction's `expiresDate` is the
 *   entitlement WINDOW, never the liveness verdict — a billing-retry sub has a
 *   past `expiresDate` but must NOT be expired by us. Every signed payload is
 *   verified through the JWS verifier before being trusted.
 *
 * Money (src/payments/AGENTS.md law):
 *   ALL balance movement goes through the idempotent per-period helpers —
 *   `grantSubscriptionPeriod` / `forfeitSubscriptionPeriod` — inside the same
 *   transaction as the row update. A terminal transition forfeits the period
 *   the row was in, which NO-OPS (`skipped_nothing_to_forfeit`) when that
 *   period's grant was never written — reconciling a never-granted expired row
 *   moves zero credits. An entitled row with a missing current-period grant is
 *   materialized via `grantSubscriptionPeriod` (idempotent on the per-period
 *   key — replays no-op). Dry-run only READS the ledger.
 *
 * Write-guards (ported from 2b0b041):
 *   - Monotonic: never roll `currentPeriodEnd` backwards, except a confirmed
 *     rescue (non-entitled row the provider reports live again).
 *   - Non-extending grace clamp on `gracePeriodEnd`.
 *   - Concurrency-guarded apply: `updateMany` predicated on the `updatedAt`
 *     read at plan time — a webhook/verify landing mid-run wins, we skip.
 *   - Fail-safe: any provider error or ambiguous data leaves the row
 *     UNCHANGED (`provider_unresolved`).
 */

const dateMs = (
  value: Date | number | string | undefined | null,
): number | null => {
  if (value === undefined || value === null) return null;
  const ms =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/**
 * The diff a provider poll resolves into. `null` is the fail-safe signal:
 * "could not resolve ground truth — do NOT touch the row this run."
 */
type ResolvedTruth = NotificationStateUpdate | null;

/**
 * Build the entitlement update from an Apple status item — the per-item
 * `status` enum plus the decoded transaction and (optional) renewal info.
 * Ported verbatim from 2b0b041 (see the module doc for the mapping contract).
 *
 *   1 ACTIVE   → active (or trial), window = expiresDate; clear gracePeriodEnd.
 *   4 GRACE    → grace, gracePeriodEnd = renewalInfo.gracePeriodExpiresDate
 *                (the real access deadline). ABSENT deadline → fail safe (null).
 *   3 RETRY    → billingRetry WITHOUT a window and gracePeriodEnd cleared;
 *                status.ts governs the row by currentPeriodEnd.
 *   2 EXPIRED  → expired; clear gracePeriodEnd.
 *   5 REVOKED  → revoked; clear gracePeriodEnd.
 *   unknown    → null (fail closed; leave the row for a later run).
 */
const appleStatusItemToUpdate = (
  appleStatus: AppleSubscriptionStatus | number | undefined,
  transaction: JWSTransactionDecodedPayload,
  renewalInfo: JWSRenewalInfoDecodedPayload | null,
  now: Date,
): ResolvedTruth => {
  switch (appleStatus) {
    case AppleSubscriptionStatus.ACTIVE: {
      // Without an expiry we cannot reason about the window — fail safe.
      const expiresMs = dateMs(transaction.expiresDate);
      if (expiresMs === null) return null;
      // Defensive: Apple says active but the window already lapsed — treat as
      // unresolved rather than fabricate an active window in the past.
      if (expiresMs <= now.getTime()) return null;
      // status=1 covers both a paid active period and an introductory free
      // trial. Reuse the transaction-derived status (offerType-aware) to keep
      // the trial flag; the future-expiry gate above means it cannot derive
      // `expired` here.
      const derived = deriveSubscriptionStatusFromTransaction(transaction, now);
      const isTrial = derived === SubscriptionStatus.trial;
      const update: NotificationStateUpdate = {
        status: isTrial ? SubscriptionStatus.trial : SubscriptionStatus.active,
        currentPeriodEnd: new Date(expiresMs),
        isInTrial: isTrial,
        // Recovered to active — any prior grace window is over.
        gracePeriodEnd: null,
      };
      // Apple status=1 does NOT imply auto-renew is on (a cancelled sub stays
      // active until the period ends). Derive willRenew from the verified
      // renewal info when we have it; otherwise leave the stored flag alone.
      if (renewalInfo?.autoRenewStatus !== undefined) {
        update.willRenew = renewalInfo.autoRenewStatus === 1;
      }
      const purchaseMs = dateMs(transaction.purchaseDate);
      if (purchaseMs !== null) {
        update.currentPeriodStart = new Date(purchaseMs);
      }
      return update;
    }

    case AppleSubscriptionStatus.BILLING_GRACE_PERIOD: {
      const graceMs = dateMs(renewalInfo?.gracePeriodExpiresDate);
      // Fail-SAFE: status=4 with no real grace deadline → leave the row
      // UNCHANGED, do NOT actively write `expired`. status.ts fail-closes an
      // un-refreshed grace row past its deadline at read time.
      if (graceMs === null) return null;
      const update: NotificationStateUpdate = {
        status: SubscriptionStatus.grace,
        // The access deadline is gracePeriodExpiresDate — the SINGLE grace
        // field status.ts gates grace entitlement on.
        gracePeriodEnd: new Date(graceMs),
      };
      // The lapsed paid-period end is the transaction expiresDate; record it
      // as the window so the monotonic guard reasons about the right value.
      // Carry the purchase date too: the item is Apple's LATEST transaction,
      // so a renewal we missed before the grace advances the period identity
      // (subject to the same stabilizer coherence rules as ACTIVE).
      const expiresMs = dateMs(transaction.expiresDate);
      if (expiresMs !== null) update.currentPeriodEnd = new Date(expiresMs);
      const purchaseMs = dateMs(transaction.purchaseDate);
      if (purchaseMs !== null) {
        update.currentPeriodStart = new Date(purchaseMs);
      }
      return update;
    }

    case AppleSubscriptionStatus.BILLING_RETRY:
      // NOT entitled per Apple contract (access ended at expiresDate), but we
      // must NOT write `expired` from the past expiresDate either (that would
      // revoke a sub Apple is still retrying). billingRetry with NO window and
      // grace cleared: status.ts governs the row by currentPeriodEnd.
      return {
        status: SubscriptionStatus.billingRetry,
        gracePeriodEnd: null,
      };

    case AppleSubscriptionStatus.EXPIRED: {
      // The provider's final period end is MANDATORY for a terminal verdict:
      // the staleness guard (mirrors applyNotification's) compares it against
      // the stored window, and a terminal write that would also forfeit must
      // never run without that comparison. Missing/invalid → fail safe.
      const expiresMs = dateMs(transaction.expiresDate);
      if (expiresMs === null) return null;
      return {
        status: SubscriptionStatus.expired,
        willRenew: false,
        gracePeriodEnd: null,
        currentPeriodEnd: new Date(expiresMs),
      };
    }

    case AppleSubscriptionStatus.REVOKED: {
      const expiresMs = dateMs(transaction.expiresDate);
      if (expiresMs === null) return null;
      return {
        status: SubscriptionStatus.revoked,
        willRenew: false,
        gracePeriodEnd: null,
        currentPeriodEnd: new Date(expiresMs),
      };
    }

    default:
      // Unknown / unset status → fail closed (leave the row for a later run).
      return null;
  }
};

type AppleTruth =
  | { kind: "unresolved"; reason: string }
  | {
      kind: "resolved";
      update: ResolvedTruth;
      appleStatus: number | undefined;
      environment: Environment;
      providerExpiresDate: Date | null;
    };

/**
 * Poll Apple for ground truth on a single subscription: fetch statuses with
 * the environment fallback (production first; a sandbox/TestFlight OTX 404s
 * there and retries against the sandbox host), match THIS subscription's
 * `originalTransactionId` in `lastTransactions`, and verify both signed
 * payloads before trusting them. Never throws.
 */
const resolveAppleTruth = async (
  sub: Subscription,
  now: Date,
  environment?: Environment,
): Promise<AppleTruth> => {
  const originalTransactionId = sub.originalTransactionId;
  if (!originalTransactionId) {
    return { kind: "unresolved", reason: "missing_original_transaction_id" };
  }

  let statuses;
  try {
    statuses = await getSubscriptionStatusesWithEnvironmentFallback(
      originalTransactionId,
      environment ? { environment } : undefined,
    );
  } catch (err) {
    logger.warn(
      { err, subscriptionId: sub.id, op: "subscription_reconcile" },
      "subscription_reconcile.apple.status_fetch_failed",
    );
    return { kind: "unresolved", reason: "status_fetch_failed" };
  }

  // Match the status item for THIS subscription's originalTransactionId.
  // `lastTransactions` carries one entry per product in the subscription
  // group; match explicitly rather than taking the first item.
  const groups = statuses.response.data ?? [];
  let matched:
    | {
        status?: AppleSubscriptionStatus | number;
        signedTransactionInfo?: string;
        signedRenewalInfo?: string;
      }
    | undefined;
  for (const group of groups) {
    for (const item of group.lastTransactions ?? []) {
      if (item.originalTransactionId === originalTransactionId) {
        matched = item;
        break;
      }
    }
    if (matched) break;
  }
  // No matching status item, or no signed transaction → ambiguous, fail safe.
  if (!matched?.signedTransactionInfo) {
    return { kind: "unresolved", reason: "no_matching_status_item" };
  }

  let transaction: JWSTransactionDecodedPayload;
  try {
    transaction = await verifyAndDecodeTransaction(
      matched.signedTransactionInfo,
    );
  } catch (err) {
    logger.warn(
      { err, subscriptionId: sub.id, op: "subscription_reconcile" },
      "subscription_reconcile.apple.jws_verify_failed",
    );
    return { kind: "unresolved", reason: "jws_verify_failed" };
  }

  // Product identity guard: an upgrade/downgrade changes the productId, and
  // granting with the row's stored tier/period would mint the wrong
  // allotment. The pilot does not remap SKUs — it fails safe and leaves the
  // row for the operator (the fleet job will carry the productId→tier/period
  // remap when it lands). A MISSING provider productId also fails safe:
  // grant sizing cannot be authenticated without it.
  if (transaction.productId !== sub.productId) {
    logger.warn(
      {
        subscriptionId: sub.id,
        storedProductId: sub.productId,
        providerProductId: transaction.productId,
        op: "subscription_reconcile",
      },
      "subscription_reconcile.apple.product_id_mismatch",
    );
    return { kind: "unresolved", reason: "product_id_mismatch" };
  }

  // Decode renewal info when present — it carries gracePeriodExpiresDate, the
  // only source of the real grace deadline (status=4). A verify failure here
  // is fail-safe: we can't trust grace, so leave the row untouched.
  let renewalInfo: JWSRenewalInfoDecodedPayload | null = null;
  if (matched.signedRenewalInfo) {
    try {
      renewalInfo = await verifyAndDecodeRenewalInfo(matched.signedRenewalInfo);
    } catch (err) {
      logger.warn(
        { err, subscriptionId: sub.id, op: "subscription_reconcile" },
        "subscription_reconcile.apple.renewal_verify_failed",
      );
      return { kind: "unresolved", reason: "renewal_verify_failed" };
    }
  }

  const expiresMs = dateMs(transaction.expiresDate);
  return {
    kind: "resolved",
    update: appleStatusItemToUpdate(
      matched.status,
      transaction,
      renewalInfo,
      now,
    ),
    appleStatus: matched.status,
    environment: statuses.environment,
    providerExpiresDate: expiresMs === null ? null : new Date(expiresMs),
  };
};

/**
 * Decide whether the resolved provider truth should be written (ported from
 * 2b0b041). Write when the provider status differs from ours, the grace
 * deadline genuinely changed, or the provider window is strictly LATER than
 * what we hold. Same window + same status + same deadline is a no-op.
 */
const shouldWrite = (
  sub: Subscription,
  update: NotificationStateUpdate,
): boolean => {
  const newEnd = dateMs(update.currentPeriodEnd);
  const currentEnd = sub.currentPeriodEnd.getTime();

  const newStatus = update.status;
  const statusChanged = newStatus !== undefined && newStatus !== sub.status;
  if (statusChanged) return true;

  // The grace deadline moved (set / cleared / pulled in) → write it.
  const newDeadline = dateMs(update.gracePeriodEnd);
  const currentDeadline = sub.gracePeriodEnd
    ? sub.gracePeriodEnd.getTime()
    : null;
  if (
    "gracePeriodEnd" in update &&
    newDeadline !== currentDeadline &&
    // A clamp no-op (new >= existing, both set) is handled by the clamp; only
    // treat a genuine change as write-worthy.
    !(
      newDeadline !== null &&
      currentDeadline !== null &&
      newDeadline >= currentDeadline
    )
  ) {
    return true;
  }

  // Otherwise only advance the window forward. Equal/older window with the
  // same status is a replay/no-op.
  if (newEnd !== null && newEnd > currentEnd) return true;

  return false;
};

const RESCUABLE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.expired,
  SubscriptionStatus.revoked,
];

const ENTITLED_TO_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.active,
  SubscriptionStatus.trial,
  SubscriptionStatus.grace,
  SubscriptionStatus.billingRetry,
];

const isRescue = (
  sub: Subscription,
  update: NotificationStateUpdate,
): boolean =>
  RESCUABLE_SUBSCRIPTION_STATUSES.includes(sub.status) &&
  update.status !== undefined &&
  ENTITLED_TO_STATUSES.includes(update.status);

/**
 * Project the update onto the monotonic floor (ported from 2b0b041): never let
 * `currentPeriodEnd` go backwards even if the provider returned an older
 * window — EXCEPT a confirmed rescue (a non-entitled DB row the provider
 * reports entitled again), where provider truth wins verbatim.
 */
const monotonicUpdate = (
  sub: Subscription,
  update: NotificationStateUpdate,
): NotificationStateUpdate => {
  const newEnd = dateMs(update.currentPeriodEnd);
  if (newEnd === null) return update;
  if (isRescue(sub, update)) return update;
  if (newEnd < sub.currentPeriodEnd.getTime()) {
    const {
      currentPeriodEnd: _drop,
      currentPeriodStart: _dropStart,
      ...rest
    } = update;
    return rest;
  }
  return update;
};

/**
 * Non-extending clamp on the grace deadline (ported from 2b0b041, mirrors the
 * webhook path): once stamped, a later poll may only pull it IN
 * (`min(existing, new)`), never push it out. Clearing to null is always
 * honored, and a rescue takes the provider deadline verbatim.
 */
const clampGracePeriodEnd = (
  sub: Subscription,
  update: NotificationStateUpdate,
): NotificationStateUpdate => {
  const next = update.gracePeriodEnd;
  const prev = sub.gracePeriodEnd;
  if (!next || !prev) return update;
  if (isRescue(sub, update)) return update;
  return next.getTime() <= prev.getTime()
    ? update
    : { ...update, gracePeriodEnd: prev };
};

/**
 * Period-identity stabilizer: `currentPeriodStart` is the grant/forfeit
 * idempotency-key anchor (`sub_grant_<id>_<startEpoch>`), so rewriting it
 * WITHOUT a genuine period change would re-key the same real period — a
 * drifting provider `purchaseDate` on an unchanged window could then mint a
 * second grant for a period that was already granted under the stored start.
 * Keep the stored start unless the window END strictly advances (a real
 * renewal moves both) or a rescue takes provider truth verbatim.
 */
const stabilizePeriodIdentity = (
  sub: Subscription,
  update: NotificationStateUpdate,
): NotificationStateUpdate => {
  if (update.currentPeriodStart === undefined) return update;
  if (isRescue(sub, update)) return update;
  const newEnd = dateMs(update.currentPeriodEnd);
  const newStart = update.currentPeriodStart.getTime();
  // Accept a new period identity only when the window moves COHERENTLY
  // forward: both end and start strictly advance (a real renewal). An
  // advancing end with a non-advancing start would re-key money under an
  // older/equal start while `planMoney` sees no period advance — a second
  // grant key for an already-granted stretch. Keep the stored identity then.
  if (
    newEnd !== null &&
    newEnd > sub.currentPeriodEnd.getTime() &&
    newStart > sub.currentPeriodStart.getTime()
  ) {
    return update;
  }
  const { currentPeriodStart: _drop, ...rest } = update;
  return rest;
};

/**
 * Terminal staleness guard (mirrors `applyNotification`'s): an EXPIRED/REVOKED
 * verdict whose provider window predates the stored one describes an OLDER
 * period than the row holds — refuse the entire update rather than terminalize
 * (and forfeit) a newer local period on stale provider data.
 */
const isStaleTerminalUpdate = (
  sub: Subscription,
  update: NotificationStateUpdate,
): boolean =>
  update.status !== undefined &&
  isTerminalStatus(update.status) &&
  update.currentPeriodEnd !== undefined &&
  update.currentPeriodEnd.getTime() < sub.currentPeriodEnd.getTime();

/**
 * Grant gate for the reconcile job. `isEntitledSubscription` is time-aware for
 * active/trial/grace but passes `billingRetry` through unconditionally (the
 * known no-TTL gap, status.ts) — under which a long-lapsed row Apple reports
 * as status 3 would mint a full grant for a period whose paid window is over.
 * Worse, the row's own `currentPeriodEnd` cannot be trusted as the check
 * (Apple status 3 carries no window we apply, so the gate would read a
 * possibly-stale/fabricated local end). The reconcile job therefore
 * categorically refuses to materialize grants for billingRetry targets: Apple
 * status 3 means the paid window ENDED at `expiresDate`; if a genuine grant is
 * missing, the user's next verify materializes it through the normal path.
 */
const isEntitledForReconcileGrant = (
  fields: {
    status: SubscriptionStatus;
    currentPeriodEnd: Date;
    gracePeriodEnd: Date | null;
  },
  now: Date,
): boolean => {
  if (fields.status === SubscriptionStatus.billingRetry) return false;
  return isEntitledSubscription(fields, now);
};

export type ReconcileMoneyReport = {
  forfeit?: {
    periodStart: string;
    /** Whether a sub_grant row exists for that period (dry-run: predicts the
     *  no-op; apply: the helper's actual verdict is in `result`). */
    priorGrantExists: boolean;
    result?: ForfeitSubscriptionPeriodResult["kind"];
  };
  grant?: {
    periodStart: string;
    alreadyGranted: boolean;
    credits: number;
    result?: GrantSubscriptionPeriodResult["kind"];
  };
};

export type OtxReconcileResult = {
  originalTransactionId: string;
  outcome:
    | "no_row"
    | "provider_unresolved"
    | "noop"
    | "planned"
    | "applied"
    | "skipped_row_changed"
    | "error";
  subscriptionId?: string;
  accountId?: string;
  before?: {
    status: SubscriptionStatus;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    gracePeriodEnd: string | null;
    environment: string | null;
  };
  provider?: {
    appleStatus: number | null;
    environment: string;
    expiresDate: string | null;
  };
  /** ISO-serialized intended row update (dry-run and apply). */
  intendedUpdate?: Record<string, string | boolean | null>;
  after?: {
    status: SubscriptionStatus;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    gracePeriodEnd: string | null;
  };
  money: ReconcileMoneyReport;
  unresolvedReason?: string;
  error?: string;
};

export type AllowlistReconcileSummary = {
  runAt: Date;
  mode: "dry-run" | "apply";
  results: OtxReconcileResult[];
};

export type RunAppleAllowlistReconcileOptions = {
  /** Explicit allowlist — the ONLY selection mechanism in the pilot. */
  originalTransactionIds: string[];
  /** Execute the writes. Default false = dry-run (writes nothing). */
  apply?: boolean;
  /** Pin the App Store Server API environment (skips the fallback). */
  environment?: Environment;
  /** Actor recorded on AdminAudit rows written in apply mode. */
  actorEmail?: string;
  now?: Date;
};

const serializeUpdate = (
  update: NotificationStateUpdate,
): Record<string, string | boolean | null> => {
  const out: Record<string, string | boolean | null> = {};
  if (update.status !== undefined) out.status = update.status;
  if (update.currentPeriodStart !== undefined)
    out.currentPeriodStart = update.currentPeriodStart.toISOString();
  if (update.currentPeriodEnd !== undefined)
    out.currentPeriodEnd = update.currentPeriodEnd.toISOString();
  if (update.willRenew !== undefined) out.willRenew = update.willRenew;
  if (update.isInTrial !== undefined) out.isInTrial = update.isInTrial;
  if ("gracePeriodEnd" in update)
    out.gracePeriodEnd = iso(update.gracePeriodEnd ?? null);
  if ("cancelledAt" in update)
    out.cancelledAt = iso(update.cancelledAt ?? null);
  return out;
};

const hasPeriodGrant = async (
  accountId: string,
  subscriptionId: string,
  periodStart: Date,
): Promise<boolean> => {
  // Read-only ledger lookup (reporting only — allowed by the payments law).
  const row = await prisma.creditLedger.findUnique({
    where: {
      accountId_idempotencyKey: {
        accountId,
        idempotencyKey: subGrantKey(subscriptionId, periodStart),
      },
    },
  });
  return row !== null;
};

const isTerminalStatus = (status: SubscriptionStatus): boolean =>
  status === SubscriptionStatus.expired ||
  status === SubscriptionStatus.revoked;

/**
 * Plan the money side effects of `safeUpdate` for reporting. Mirrors the
 * apply path's branches; reads the ledger, writes nothing.
 */
const planMoney = async (
  sub: Subscription,
  safeUpdate: NotificationStateUpdate,
  now: Date,
): Promise<ReconcileMoneyReport> => {
  const money: ReconcileMoneyReport = {};
  const targetStatus = safeUpdate.status ?? sub.status;
  const targetPeriodStart =
    safeUpdate.currentPeriodStart ?? sub.currentPeriodStart;

  if (isTerminalStatus(targetStatus)) {
    // Forfeit only on an actual TRANSITION into a terminal status. A row that
    // is already terminal never gets a retroactive forfeit backfill from this
    // job — clawing back long-kept credits is a policy call out of pilot
    // scope.
    if (!isTerminalStatus(sub.status)) {
      money.forfeit = {
        periodStart: sub.currentPeriodStart.toISOString(),
        priorGrantExists: await hasPeriodGrant(
          sub.accountId,
          sub.id,
          sub.currentPeriodStart,
        ),
      };
    }
    return money;
  }

  if (isEntitledSubscriptionStatus(targetStatus)) {
    const periodAdvanced =
      targetPeriodStart.getTime() > sub.currentPeriodStart.getTime();
    if (periodAdvanced) {
      money.forfeit = {
        periodStart: sub.currentPeriodStart.toISOString(),
        priorGrantExists: await hasPeriodGrant(
          sub.accountId,
          sub.id,
          sub.currentPeriodStart,
        ),
      };
    }
    const projected = {
      status: targetStatus,
      currentPeriodEnd: safeUpdate.currentPeriodEnd ?? sub.currentPeriodEnd,
      gracePeriodEnd:
        "gracePeriodEnd" in safeUpdate
          ? (safeUpdate.gracePeriodEnd ?? null)
          : sub.gracePeriodEnd,
    };
    // Time-aware gate (verify's replay-materializer + the billingRetry
    // paid-window requirement): never plan a grant for an effectively-expired
    // window.
    if (isEntitledForReconcileGrant(projected, now)) {
      money.grant = {
        periodStart: targetPeriodStart.toISOString(),
        alreadyGranted: await hasPeriodGrant(
          sub.accountId,
          sub.id,
          targetPeriodStart,
        ),
        credits: tierGrant(requireSubscriptionTier(sub.tier), sub.period)
          .perPeriod,
      };
    }
  }
  return money;
};

type AppliedOutcome = {
  outcome: "applied" | "skipped_row_changed";
  updated?: Subscription;
  grantResult?: GrantSubscriptionPeriodResult;
  forfeitResult?: ForfeitSubscriptionPeriodResult;
};

/**
 * Apply the reconcile update atomically. The row write is concurrency-guarded
 * on the `updatedAt` read at plan time (a fresher verify/webhook wins — skip);
 * money moves ONLY through the idempotent per-period helpers, in the same
 * transaction, mirroring `applyNotification`'s branches:
 *   - TRANSITION into a terminal status → forfeit the period the row was in
 *     (no-ops when that period was never granted; already-terminal rows are
 *     never retro-forfeited — pilot policy);
 *   - entitled + period advanced → forfeit the old period (consumes bounded to
 *     the new period start), then grant the new period;
 *   - entitled + time-aware live window → materialize a missing current-period
 *     grant (idempotent replay when it exists).
 * The AdminAudit row commits in the SAME transaction, keyed on the guarded
 * snapshot's `updatedAt` — unique per CAS-guarded apply, replay-stable on a
 * retry of the same snapshot.
 */
const applyReconcileUpdate = async (
  snapshot: Subscription,
  safeUpdate: NotificationStateUpdate,
  now: Date,
  audit: { actorEmail: string; originalTransactionId: string },
): Promise<AppliedOutcome> =>
  prisma.$transaction(async (tx) => {
    const guarded = await tx.subscription.updateMany({
      where: { id: snapshot.id, updatedAt: snapshot.updatedAt },
      data: safeUpdate,
    });
    if (guarded.count === 0) {
      return { outcome: "skipped_row_changed" as const };
    }
    const updated = await tx.subscription.findUniqueOrThrow({
      where: { id: snapshot.id },
    });

    let grantResult: GrantSubscriptionPeriodResult | undefined;
    let forfeitResult: ForfeitSubscriptionPeriodResult | undefined;

    if (isTerminalStatus(updated.status)) {
      if (!isTerminalStatus(snapshot.status)) {
        forfeitResult = await forfeitSubscriptionPeriod(tx, {
          subscription: updated,
          periodStart: snapshot.currentPeriodStart,
        });
      }
    } else if (isEntitledSubscriptionStatus(updated.status)) {
      if (
        updated.currentPeriodStart.getTime() >
        snapshot.currentPeriodStart.getTime()
      ) {
        forfeitResult = await forfeitSubscriptionPeriod(tx, {
          subscription: updated,
          periodStart: snapshot.currentPeriodStart,
          consumesUntil: updated.currentPeriodStart,
        });
      }
      if (isEntitledForReconcileGrant(updated, now)) {
        grantResult = await grantSubscriptionPeriod(tx, {
          subscription: updated,
          periodStart: updated.currentPeriodStart,
        });
      }
    }

    const granted =
      grantResult?.kind === "granted" ? BigInt(grantResult.credits) : 0n;
    const forfeited =
      forfeitResult?.kind === "forfeited" ? BigInt(forfeitResult.credits) : 0n;
    await writeAdminAudit(
      {
        accountId: updated.accountId,
        actorEmail: audit.actorEmail,
        action: "reconcile",
        deltaCredits: granted - forfeited,
        reason: `apple subscription reconcile ${audit.originalTransactionId}: ${snapshot.status} -> ${updated.status}`,
        idempotencyKey: `sub_reconcile_${updated.id}_${snapshot.updatedAt.getTime()}`,
      },
      tx,
    );

    return { outcome: "applied" as const, updated, grantResult, forfeitResult };
  });

const DEFAULT_ACTOR_EMAIL = "subscription-reconcile-cli";

export async function runAppleAllowlistReconcile(
  opts: RunAppleAllowlistReconcileOptions,
): Promise<AllowlistReconcileSummary> {
  const now = opts.now ?? new Date();
  const apply = opts.apply ?? false;
  const actorEmail = opts.actorEmail?.trim() || DEFAULT_ACTOR_EMAIL;
  const otxIds = [...new Set(opts.originalTransactionIds)];

  const summary: AllowlistReconcileSummary = {
    runAt: now,
    mode: apply ? "apply" : "dry-run",
    results: [],
  };

  for (const originalTransactionId of otxIds) {
    const result: OtxReconcileResult = {
      originalTransactionId,
      outcome: "error",
      money: {},
    };
    summary.results.push(result);

    try {
      const sub = await findAppleByOriginalTransactionId(originalTransactionId);
      if (!sub) {
        result.outcome = "no_row";
        continue;
      }
      result.subscriptionId = sub.id;
      result.accountId = sub.accountId;
      result.before = {
        status: sub.status,
        currentPeriodStart: sub.currentPeriodStart.toISOString(),
        currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
        gracePeriodEnd: iso(sub.gracePeriodEnd),
        environment: sub.environment ?? null,
      };

      const truth = await resolveAppleTruth(sub, now, opts.environment);
      if (truth.kind === "unresolved") {
        result.outcome = "provider_unresolved";
        result.unresolvedReason = truth.reason;
        continue;
      }
      result.provider = {
        appleStatus: truth.appleStatus ?? null,
        environment: truth.environment,
        expiresDate: iso(truth.providerExpiresDate),
      };
      if (truth.update === null) {
        result.outcome = "provider_unresolved";
        result.unresolvedReason = "ambiguous_provider_state";
        continue;
      }

      // Terminal staleness guard runs on the RAW provider update, BEFORE the
      // monotonic floor could strip the regressing window and let the bare
      // terminal status through.
      if (isStaleTerminalUpdate(sub, truth.update)) {
        result.outcome = "provider_unresolved";
        result.unresolvedReason = "stale_provider_terminal";
        continue;
      }

      const safeUpdate = clampGracePeriodEnd(
        sub,
        monotonicUpdate(sub, stabilizePeriodIdentity(sub, truth.update)),
      );
      const rowChangeNeeded = shouldWrite(sub, safeUpdate);
      const money = await planMoney(sub, safeUpdate, now);
      // An entitled, time-aware-live row missing its current-period sub_grant
      // is money drift even when the row state itself is in sync — still
      // reconcile it (the grant helper is idempotent either way).
      const grantMaterializationNeeded =
        money.grant !== undefined && !money.grant.alreadyGranted;
      if (!rowChangeNeeded && !grantMaterializationNeeded) {
        result.outcome = "noop";
        continue;
      }
      if (rowChangeNeeded) {
        result.intendedUpdate = serializeUpdate(safeUpdate);
      }
      result.money = money;

      if (!apply) {
        result.outcome = "planned";
        continue;
      }

      const applied = await applyReconcileUpdate(sub, safeUpdate, now, {
        actorEmail,
        originalTransactionId,
      });
      result.outcome = applied.outcome;
      if (applied.outcome !== "applied" || !applied.updated) continue;

      const updated = applied.updated;
      result.after = {
        status: updated.status,
        currentPeriodStart: updated.currentPeriodStart.toISOString(),
        currentPeriodEnd: updated.currentPeriodEnd.toISOString(),
        gracePeriodEnd: iso(updated.gracePeriodEnd),
      };
      if (result.money.forfeit && applied.forfeitResult) {
        result.money.forfeit.result = applied.forfeitResult.kind;
      }
      if (result.money.grant && applied.grantResult) {
        result.money.grant.result = applied.grantResult.kind;
      }

      logger.info(
        {
          subscriptionId: updated.id,
          accountId: updated.accountId,
          statusBefore: sub.status,
          statusAfter: updated.status,
          granted:
            applied.grantResult?.kind === "granted"
              ? applied.grantResult.credits
              : 0,
          forfeited:
            applied.forfeitResult?.kind === "forfeited"
              ? applied.forfeitResult.credits
              : 0,
          op: "subscription_reconcile",
        },
        "subscription_reconcile.applied",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, originalTransactionId, op: "subscription_reconcile" },
        "subscription_reconcile.otx.failed",
      );
      result.outcome = "error";
      result.error = message;
    }
  }

  logger.info(
    {
      mode: summary.mode,
      outcomes: summary.results.map((r) => ({
        otx: r.originalTransactionId,
        outcome: r.outcome,
      })),
      runAt: now.toISOString(),
      op: "subscription_reconcile",
    },
    "subscription_reconcile.completed",
  );

  return summary;
}
