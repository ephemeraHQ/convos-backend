import {
  Status as AppleSubscriptionStatus,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import { BillingProvider, SubscriptionStatus } from "@prisma/client";
import { getSubscriptionStatuses } from "@/subscriptions/apple-server-api";
import {
  verifyAndDecodeRenewalInfo,
  verifyAndDecodeTransaction,
} from "@/subscriptions/jws-verifier";
import {
  type NotificationStateUpdate,
  type Subscription,
} from "@/subscriptions/repository";
import {
  deriveSubscriptionStatusFromTransaction,
  ENTITLED_SUBSCRIPTION_STATUSES,
} from "@/subscriptions/status";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Entitlement reconciliation cron.
 *
 * Closes "entitlement drift": when a renewal webhook is dropped (network,
 * mis-config, provider delay) or the app stays dormant, `currentPeriodEnd`
 * goes stale and `effectiveSubscriptionStatus` (status.ts) reads the row as
 * `expired` → the derived subscriber balance silently falls to ~0 even though
 * the subscription is still live with the provider.
 *
 * This job re-fetches PROVIDER GROUND TRUTH for at-risk subscriptions and
 * refreshes the local entitlement window/status through a thin, guarded
 * `subscription.updateMany` — the same fields a live webhook writes via
 * `applyNotification`. It writes ZERO credit rows; the derived read recomputes
 * the balance from the refreshed window.
 *
 * Single grace-deadline field — `gracePeriodEnd`:
 *   The whole stack reasons about exactly one provider grace deadline,
 *   `gracePeriodEnd`. `status.ts` entitles a `grace` row until
 *   `gracePeriodEnd ?? currentPeriodEnd`. The webhook path already writes
 *   `gracePeriodEnd`; this cron MUST do the same so a cron-refreshed grace row
 *   reads entitled. (The earlier `billingRetryEndsAt` field is gone — never
 *   write it.)
 *
 * Provider truth, not transaction expiry (the catastrophic-regression fix):
 *   - Apple liveness comes from the per-item `status` enum on
 *     `getSubscriptionStatuses` (1 active / 2 expired / 3 billing-retry /
 *     4 grace / 5 revoked) PLUS the decoded `signedRenewalInfo`
 *     (`gracePeriodExpiresDate`). The transaction's `expiresDate` is the
 *     entitlement WINDOW, never the liveness verdict — a billing-retry sub has
 *     a past `expiresDate` but must NOT be expired by us.
 *   - Google liveness comes from `subscriptionState`
 *     (ACTIVE/IN_GRACE_PERIOD/CANCELED-until-expiry → entitled; ON_HOLD/PAUSED/
 *     EXPIRED/PENDING → not). For IN_GRACE_PERIOD the grace deadline is the
 *     line item's `expiryTime` (Google extends that field).
 *
 * Invariants (adversarially reviewed):
 *   - Idempotent + monotonic: a refresh only ever ADVANCES `currentPeriodEnd`
 *     to provider truth. A second run with no provider change is a no-op. We
 *     never regress a newer window to an older value — EXCEPT a confirmed
 *     rescue (a non-entitled DB row the provider reports live again), where
 *     provider truth must win even if its window is older than a stale local
 *     one (see `monotonicUpdate`).
 *   - Non-extending grace clamp: `gracePeriodEnd` is only ever pulled in
 *     (`min(existing, new)`), never pushed out; clearing it to null is honored.
 *   - Grace deadline cleared on not-entitled transitions: a sub that leaves
 *     grace for billing-retry / hold / expired / revoked has its
 *     `gracePeriodEnd` explicitly nulled, so status.ts can't keep it entitled
 *     past the provider cutoff.
 *   - Concurrency-guarded: the write is an `updateMany` predicated on the
 *     `updatedAt` read at scan time. If a webhook (or another run) advanced the
 *     row mid-poll, the guard matches 0 rows and we SKIP — never clobber the
 *     fresher write.
 *   - Fail-safe: any provider error (network, throttle, auth, 5xx) or
 *     ambiguous/missing data leaves the row UNCHANGED and is counted as
 *     `errored`. We never expire or extend a sub on a failed/uncertain poll —
 *     including a status=4 grace with no `gracePeriodExpiresDate` present
 *     (leave the row, retry next run; status.ts fail-closes the read).
 *   - Per-sub isolation: one sub's failure never aborts the batch.
 */

/** Default look-ahead: refresh subs expiring within the next 3 days (or
 *  already past). Tunable via the cron caller; keeps the scan to the at-risk
 *  set rather than every sub. */
const DEFAULT_LOOKAHEAD_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Bound the "expired-but-maybe-live-again" rescue scan: only re-poll rows
 *  written to a non-entitled status whose `updatedAt` is within this recent
 *  window. A sub that lapsed long ago is not revived (the user re-subscribes
 *  through /verify). Without this bound the scan would touch every
 *  expired-ever row. */
const DEFAULT_RESCUE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Cap the rows touched per run so a backlog can't blow the request budget;
 *  the next run picks up the remainder (the scan is ordered oldest-first). */
const DEFAULT_BATCH_LIMIT = 200;

/** Non-entitled DB statuses that the rescue scan re-polls within the bounded
 *  recent window, in case the provider reports the sub live again. */
const RESCUABLE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.expired,
  SubscriptionStatus.revoked,
];

const isRescuableStatus = (status: SubscriptionStatus): boolean =>
  RESCUABLE_SUBSCRIPTION_STATUSES.includes(status);

export type EntitlementReconcileSummary = {
  runAt: Date;
  /** Subscriptions matched by the at-risk + rescue scan. */
  scanned: number;
  /** Rows whose window/status was advanced to provider truth. */
  refreshed: Array<{
    accountId: string;
    subscriptionId: string;
    provider: BillingProvider;
    previousPeriodEnd: string;
    newPeriodEnd: string;
    newStatus: SubscriptionStatus;
  }>;
  /** Rows already up to date, or whose provider truth was older/equal
   *  (no-op, monotonic floor held). */
  noOp: number;
  /** Rows we deliberately skipped: a provider we can't resolve, a missing
   *  identifier, OR a concurrency-guard miss (a webhook advanced the row
   *  mid-run — the webhook is fresher, so we leave it). Not an error. */
  skipped: number;
  /** Rows left UNCHANGED because the provider poll failed or returned
   *  ambiguous data. Retried next run. */
  errors: Array<{ subscriptionId: string; error: string }>;
};

export type RunEntitlementReconcileOptions = {
  now?: Date;
  /** Look-ahead window (ms) applied to `currentPeriodEnd` when scanning
   *  entitled rows. */
  lookaheadWindowMs?: number;
  /** Recent-`updatedAt` window (ms) bounding the expired/revoked rescue scan. */
  rescueWindowMs?: number;
  /** Max rows to process this run. */
  limit?: number;
};

/**
 * The diff a provider poll resolves into. `null` is the fail-safe signal:
 * "could not resolve ground truth — do NOT touch the row this run."
 */
type ResolvedTruth = NotificationStateUpdate | null;

const dateMs = (
  value: Date | number | string | undefined | null,
): number | null => {
  if (value === undefined || value === null) return null;
  const ms =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Build the entitlement update from an Apple status item — the per-item
 * `status` enum plus the decoded transaction and (optional) renewal info.
 *
 * This deliberately keys liveness off the `status` enum, NOT the transaction's
 * `expiresDate`. A billing-retry (status=3) or grace (status=4) sub has a past
 * `expiresDate`; deriving "expired" from that alone is the catastrophic
 * regression this cron exists to avoid.
 *
 * Mapping (contract ref):
 *   1 ACTIVE   → active (or trial), window = expiresDate; clear gracePeriodEnd.
 *   4 GRACE    → grace, window = expiresDate (lapsed paid period), and
 *                gracePeriodEnd = renewalInfo.gracePeriodExpiresDate (the real
 *                access deadline; status.ts entitles the row until it). If that
 *                date is ABSENT, fail SAFE: return null (leave the row, retry
 *                next run) — do NOT actively write `expired` on a partial
 *                provider response.
 *   3 RETRY    → NOT entitled (contract). Do NOT write `expired` from the past
 *                transaction expiresDate. Emit billingRetry WITHOUT a
 *                window/expiry and CLEAR any stale gracePeriodEnd, so status.ts
 *                governs the row by currentPeriodEnd (entitled only within the
 *                already-paid period).
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
      // the trial flag, but never let it derive `expired` here — we already
      // gated on a future expiry above.
      const derived = deriveSubscriptionStatusFromTransaction(transaction, now);
      const isTrial = derived === SubscriptionStatus.trial;
      const update: NotificationStateUpdate = {
        status: isTrial ? SubscriptionStatus.trial : SubscriptionStatus.active,
        currentPeriodEnd: new Date(expiresMs),
        isInTrial: isTrial,
        willRenew: true,
        // Recovered to active — any prior grace window is over.
        gracePeriodEnd: null,
      };
      const purchaseMs = dateMs(transaction.purchaseDate);
      if (purchaseMs !== null) {
        update.currentPeriodStart = new Date(purchaseMs);
      }
      return update;
    }

    case AppleSubscriptionStatus.BILLING_GRACE_PERIOD: {
      const graceMs = dateMs(renewalInfo?.gracePeriodExpiresDate);
      // S-N3 fail-SAFE: status=4 with no real grace deadline → leave the row
      // UNCHANGED (return null), do NOT actively write `expired`. The cron must
      // not revoke a live grace sub on a transient/partial provider response;
      // status.ts fail-closes an un-refreshed grace row past its deadline at
      // read time. Self-heals when the date reappears next run.
      if (graceMs === null) return null;
      const update: NotificationStateUpdate = {
        status: SubscriptionStatus.grace,
        // The access deadline is gracePeriodExpiresDate — the SINGLE grace
        // field status.ts gates grace entitlement on. The cron has the REAL
        // deadline here (from renewalInfo), better than the webhook's
        // expiresDate fallback.
        gracePeriodEnd: new Date(graceMs),
      };
      // The lapsed paid-period end is the transaction expiresDate; record it as
      // the window so the monotonic guard reasons about the right value.
      const expiresMs = dateMs(transaction.expiresDate);
      if (expiresMs !== null) update.currentPeriodEnd = new Date(expiresMs);
      return update;
    }

    case AppleSubscriptionStatus.BILLING_RETRY:
      // NOT entitled (contract: status=3 access ended at expiresDate). We must
      // NOT write `expired` from the transaction's past expiresDate (that would
      // revoke a sub Apple is still retrying). Emit billingRetry with NO
      // window/expiry and CLEAR any stale grace deadline: status.ts then
      // governs the row by currentPeriodEnd (entitled only within the paid
      // period), and the monotonic guard never regresses the window.
      return {
        status: SubscriptionStatus.billingRetry,
        gracePeriodEnd: null,
      };

    case AppleSubscriptionStatus.EXPIRED:
      return {
        status: SubscriptionStatus.expired,
        willRenew: false,
        gracePeriodEnd: null,
      };

    case AppleSubscriptionStatus.REVOKED:
      return {
        status: SubscriptionStatus.revoked,
        willRenew: false,
        gracePeriodEnd: null,
      };

    default:
      // Unknown / unset status → fail closed (leave the row for a later run).
      return null;
  }
};

/**
 * Poll Apple for ground truth on a single subscription. Returns the entitlement
 * diff, or `null` (fail-safe) on any error / ambiguity. Never throws.
 */
const resolveAppleTruth = async (
  sub: Subscription,
  now: Date,
): Promise<ResolvedTruth> => {
  const originalTransactionId = sub.originalTransactionId;
  if (!originalTransactionId) return null;

  let statuses;
  try {
    statuses = await getSubscriptionStatuses(originalTransactionId);
  } catch (err) {
    logger.warn(
      {
        err,
        subscriptionId: sub.id,
        provider: "apple",
        op: "entitlement_reconcile",
      },
      "entitlement_reconcile.apple.status_fetch_failed",
    );
    return null;
  }

  // N-N3: find the status item for THIS subscription's originalTransactionId.
  // `lastTransactions` carries one entry per product in the subscription group;
  // we must match on `originalTransactionId` (the stable per-line id), not just
  // take the first group/item — otherwise a multi-product group could resolve
  // the wrong line. Convos is single-product today, but match explicitly so
  // this is correct if that ever changes. We need the item's `status` enum
  // (liveness) and both signed payloads.
  const groups = statuses.data ?? [];
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
  if (!matched?.signedTransactionInfo) return null;

  let transaction: JWSTransactionDecodedPayload;
  try {
    transaction = await verifyAndDecodeTransaction(
      matched.signedTransactionInfo,
    );
  } catch (err) {
    logger.warn(
      {
        err,
        subscriptionId: sub.id,
        provider: "apple",
        op: "entitlement_reconcile",
      },
      "entitlement_reconcile.apple.jws_verify_failed",
    );
    return null;
  }

  // Decode renewal info when present — it carries gracePeriodExpiresDate, the
  // only source of the real grace deadline (status=4). A verify failure here is
  // fail-safe: we can't trust grace, so leave the row untouched.
  let renewalInfo: JWSRenewalInfoDecodedPayload | null = null;
  if (matched.signedRenewalInfo) {
    try {
      renewalInfo = await verifyAndDecodeRenewalInfo(matched.signedRenewalInfo);
    } catch (err) {
      logger.warn(
        {
          err,
          subscriptionId: sub.id,
          provider: "apple",
          op: "entitlement_reconcile",
        },
        "entitlement_reconcile.apple.renewal_verify_failed",
      );
      return null;
    }
  }

  return appleStatusItemToUpdate(matched.status, transaction, renewalInfo, now);
};

/**
 * Poll Google Play for ground truth on a single subscription. Returns the
 * entitlement diff, or `null` (fail-safe) on any error / ambiguity.
 *
 * The Play client is imported dynamically: `play-api` statically pulls in
 * `googleapis`, an optional dependency that may be absent (e.g. tests). A
 * top-level import would break module loading for the Apple path too; the
 * dynamic import keeps the cost on the Google branch only.
 *
 * Liveness is `subscriptionState` (via `deriveStatusFromPurchase`):
 *   ACTIVE/CANCELED-with-future-expiry → active (window = expiryTime),
 *     clear gracePeriodEnd.
 *   IN_GRACE_PERIOD → grace; the grace deadline IS the line item's expiryTime
 *     (Google extends that field), written to gracePeriodEnd.
 *   ON_HOLD/PAUSED → billingRetry WITHOUT a window and gracePeriodEnd cleared —
 *     leave the row governed by currentPeriodEnd (status.ts entitles a
 *     billingRetry row only within the paid period; we never expire from here).
 *   EXPIRED → expired; clear gracePeriodEnd. PENDING/UNSPECIFIED → throw inside
 *     deriveStatusFromPurchase → fail-safe.
 */
const resolveGoogleTruth = async (
  sub: Subscription,
  now: Date,
): Promise<ResolvedTruth> => {
  const purchaseToken = sub.purchaseToken;
  if (!purchaseToken) return null;

  try {
    const { fetchSubscriptionPurchaseV2 } =
      await import("@/subscriptions/google-play/play-api");
    const { deriveStatusFromPurchase, extractPeriodWindow } =
      await import("@/subscriptions/google-play/status");

    const purchase = await fetchSubscriptionPurchaseV2(purchaseToken);
    const status = deriveStatusFromPurchase(purchase, now);

    // ON_HOLD / PAUSED → billingRetry without a window, grace cleared: do NOT
    // expire, do NOT advance the window. Leave the row governed by
    // currentPeriodEnd.
    if (status === SubscriptionStatus.billingRetry) {
      return {
        status: SubscriptionStatus.billingRetry,
        gracePeriodEnd: null,
      };
    }

    if (status === SubscriptionStatus.expired) {
      return {
        status: SubscriptionStatus.expired,
        willRenew: false,
        gracePeriodEnd: null,
      };
    }

    const window = extractPeriodWindow(purchase);
    if (status === SubscriptionStatus.grace) {
      // IN_GRACE_PERIOD: the grace deadline IS the (extended) expiryTime, the
      // SINGLE grace field status.ts gates entitlement on.
      return {
        status: SubscriptionStatus.grace,
        currentPeriodStart: window.currentPeriodStart,
        currentPeriodEnd: window.currentPeriodEnd,
        gracePeriodEnd: window.currentPeriodEnd,
      };
    }

    // ACTIVE / trial (incl. CANCELED-until-expiry resolved to active/trial).
    return {
      status,
      currentPeriodStart: window.currentPeriodStart,
      currentPeriodEnd: window.currentPeriodEnd,
      isInTrial: status === SubscriptionStatus.trial,
      // Recovered to active — any prior grace window is over.
      gracePeriodEnd: null,
    };
  } catch (err) {
    logger.warn(
      {
        err,
        subscriptionId: sub.id,
        provider: "googlePlay",
        op: "entitlement_reconcile",
      },
      "entitlement_reconcile.google.fetch_failed",
    );
    return null;
  }
};

/** Sentinel for a provider we don't know how to poll. Distinct from `null`
 *  (a supported provider we polled but couldn't resolve → error/retry) so the
 *  caller can `skip` it instead of counting it as an error. */
const UNSUPPORTED_PROVIDER = Symbol("unsupported_provider");

const resolveProviderTruth = (
  sub: Subscription,
  now: Date,
): Promise<ResolvedTruth> | typeof UNSUPPORTED_PROVIDER => {
  switch (sub.provider) {
    case BillingProvider.apple:
      return resolveAppleTruth(sub, now);
    case BillingProvider.googlePlay:
      return resolveGoogleTruth(sub, now);
    default:
      return UNSUPPORTED_PROVIDER;
  }
};

/**
 * Decide whether the resolved provider truth should be written.
 *
 * Monotonic guard: never roll `currentPeriodEnd` backwards. We write when
 *   (a) the provider reports a status that differs from ours — a genuine lapse
 *       the provider confirms (active→expired/revoked/billingRetry), or the
 *       rescue case (expired/revoked DB row that is active/grace again), OR
 *   (b) the provider window is strictly LATER than what we hold (a renewal we
 *       missed — the drift case we exist to fix), OR
 *   (c) the grace deadline (`gracePeriodEnd`) changed (set / cleared / pulled
 *       in).
 * Same window + same status + same deadline is a no-op.
 */
const shouldWrite = (
  sub: Subscription,
  update: NotificationStateUpdate,
): boolean => {
  const newEnd = dateMs(update.currentPeriodEnd);
  const currentEnd = sub.currentPeriodEnd.getTime();

  const newStatus = update.status;
  const statusChanged = newStatus !== undefined && newStatus !== sub.status;

  // Provider confirms a status different from ours → reflect it. This covers
  // both the lapse case (active→expired/revoked/billingRetry) and the rescue
  // case (expired→active/grace), always on CONFIRMED provider truth, never on
  // a guess.
  if (statusChanged) return true;

  // The grace deadline moved (set / cleared / pulled in) → write it.
  const newDeadline = dateMs(update.gracePeriodEnd);
  const currentDeadline = sub.gracePeriodEnd
    ? sub.gracePeriodEnd.getTime()
    : null;
  if (
    "gracePeriodEnd" in update &&
    newDeadline !== currentDeadline &&
    // A clamp no-op (new >= existing, both set) is handled below by the clamp;
    // only treat a genuine change as write-worthy.
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

/**
 * Project the update onto the monotonic floor: never let `currentPeriodEnd`
 * go backwards even if the provider returned an older window — EXCEPT in a
 * confirmed rescue.
 *
 * S-N4 rescue-awareness: when the DB row is non-entitled (expired/revoked) and
 * the provider now reports an entitled status (active/trial/grace), provider
 * truth must win — even if its window is OLDER than a stale (possibly
 * fabricated-future) local `currentPeriodEnd`. Otherwise the monotonic floor
 * would flip the status to active/grace while KEEPING the bad local window,
 * resurrecting a dead row on a stale window. In the rescue case we therefore
 * write the provider window verbatim. A refund/revoke at the provider is NOT a
 * rescue (the to-status is expired/revoked, not entitled), so it stays expired
 * with the floor applied as usual.
 */
const ENTITLED_TO_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.active,
  SubscriptionStatus.trial,
  SubscriptionStatus.grace,
  SubscriptionStatus.billingRetry,
];

const monotonicUpdate = (
  sub: Subscription,
  update: NotificationStateUpdate,
): NotificationStateUpdate => {
  const newEnd = dateMs(update.currentPeriodEnd);
  if (newEnd === null) return update;

  // Rescue: a non-entitled DB row the provider confirms entitled again. The
  // provider window is authoritative — write it even if it regresses the stale
  // local window. (Entitlement of the new status is still governed by status.ts
  // against this provider window, so an OLD/already-past provider window simply
  // reads not-entitled rather than resurrecting access.)
  const isRescue =
    isRescuableStatus(sub.status) &&
    update.status !== undefined &&
    ENTITLED_TO_STATUSES.includes(update.status);
  if (isRescue) return update;

  // Normal monotonic floor: drop a regressing window, keep any status / flag /
  // deadline change.
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
 * Non-extending clamp on the grace deadline (`gracePeriodEnd`, mirrors the
 * webhook path in repository.ts). Once a deadline is stamped, a later poll may
 * only pull it IN (`min(existing, new)`), never push it out — a sub stuck in
 * grace must not earn unbounded free access. Clearing to null (recovery /
 * expiry / not-entitled transition) is always honored.
 *
 * R3-N1 rescue-awareness (mirrors `monotonicUpdate`): a non-entitled DB row the
 * provider confirms entitled again is a RESCUE — the provider's grace deadline
 * is authoritative and must NOT be clamped to the stale local value. Otherwise
 * an expired row carrying a stale PAST `gracePeriodEnd`, rescued by status=4
 * (grace) with a fresh FUTURE deadline, would get `min(past, future) = past` and
 * read not-entitled, stranding the rescue. Entitlement of the rescued grace
 * status is still governed by status.ts against this provider deadline, so an
 * already-past provider deadline simply reads not-entitled rather than
 * resurrecting access.
 */
const clampGracePeriodEnd = (
  sub: Subscription,
  update: NotificationStateUpdate,
): NotificationStateUpdate => {
  const next = update.gracePeriodEnd;
  const prev = sub.gracePeriodEnd;
  if (!next || !prev) return update;

  const isRescue =
    isRescuableStatus(sub.status) &&
    update.status !== undefined &&
    ENTITLED_TO_STATUSES.includes(update.status);
  if (isRescue) return update;

  return next.getTime() <= prev.getTime()
    ? update
    : { ...update, gracePeriodEnd: prev };
};

export async function runEntitlementReconcile(
  opts?: RunEntitlementReconcileOptions,
): Promise<EntitlementReconcileSummary> {
  const now = opts?.now ?? new Date();
  const lookaheadWindowMs =
    opts?.lookaheadWindowMs ?? DEFAULT_LOOKAHEAD_WINDOW_MS;
  const rescueWindowMs = opts?.rescueWindowMs ?? DEFAULT_RESCUE_WINDOW_MS;
  const limit = opts?.limit ?? DEFAULT_BATCH_LIMIT;
  const cutoff = new Date(now.getTime() + lookaheadWindowMs);
  const rescueFloor = new Date(now.getTime() - rescueWindowMs);

  // Scan two disjoint at-risk sets:
  //   1. Entitled rows whose window is near or past expiry (the drift case —
  //      a dropped renewal makes them read expired even though they're live).
  //      Uses the [status, currentPeriodEnd] index.
  //   2. Recently-lapsed rows (expired/revoked, updatedAt within the bounded
  //      rescue window) — in case the provider reports them live again and a
  //      renewal/recovery webhook was dropped (the rescue case). Bounded so we
  //      don't re-poll every expired-ever row. Uses the [status, updatedAt]
  //      index added for this scan (NEW-NIT1) — `updatedAt` is the right
  //      "recently lapsed" bound and could not ride the currentPeriodEnd index.
  // Oldest-first so a backlog drains deterministically across runs.
  const candidates = await prisma.subscription.findMany({
    where: {
      OR: [
        {
          status: { in: ENTITLED_SUBSCRIPTION_STATUSES },
          currentPeriodEnd: { lte: cutoff },
        },
        {
          status: { in: RESCUABLE_SUBSCRIPTION_STATUSES },
          updatedAt: { gte: rescueFloor },
        },
      ],
    },
    orderBy: [{ currentPeriodEnd: "asc" }],
    take: limit,
  });

  const summary: EntitlementReconcileSummary = {
    runAt: now,
    scanned: candidates.length,
    refreshed: [],
    noOp: 0,
    skipped: 0,
    errors: [],
  };

  for (const sub of candidates) {
    try {
      const resolved = resolveProviderTruth(sub, now);

      // Provider we can't poll (future BillingProvider value) → skip + log,
      // never an error.
      if (resolved === UNSUPPORTED_PROVIDER) {
        summary.skipped++;
        logger.info(
          { subscriptionId: sub.id, provider: sub.provider },
          "entitlement_reconcile.skipped.unsupported_provider",
        );
        continue;
      }

      const truth = await resolved;

      // Fail-safe: a supported provider we polled but couldn't resolve
      // (network, throttle, auth, ambiguous data, status=4 with no grace
      // deadline) → leave the row untouched, retry next run.
      if (truth === null) {
        summary.errors.push({
          subscriptionId: sub.id,
          error: "provider_unresolved",
        });
        continue;
      }

      // Project onto the (rescue-aware) monotonic floor, then apply the
      // non-extending grace clamp — exactly the webhook path's guarantees.
      const safeUpdate = clampGracePeriodEnd(sub, monotonicUpdate(sub, truth));
      if (!shouldWrite(sub, safeUpdate)) {
        summary.noOp++;
        continue;
      }

      // Concurrency guard (optimistic): predicate the write on the `updatedAt`
      // we read at scan time. If a webhook (or an overlapping run) advanced the
      // row mid-poll, `updatedAt` no longer matches → 0 rows affected → we SKIP
      // and leave the fresher write in place. Never clobber.
      const guarded = await prisma.subscription.updateMany({
        where: { id: sub.id, updatedAt: sub.updatedAt },
        data: safeUpdate,
      });

      if (guarded.count === 0) {
        summary.skipped++;
        logger.info(
          { subscriptionId: sub.id, op: "entitlement_reconcile" },
          "entitlement_reconcile.skipped.row_changed_mid_run",
        );
        continue;
      }

      const updated = await prisma.subscription.findUniqueOrThrow({
        where: { id: sub.id },
      });

      summary.refreshed.push({
        accountId: sub.accountId,
        subscriptionId: sub.id,
        provider: sub.provider,
        previousPeriodEnd: sub.currentPeriodEnd.toISOString(),
        newPeriodEnd: updated.currentPeriodEnd.toISOString(),
        newStatus: updated.status,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, subscriptionId: sub.id, op: "entitlement_reconcile" },
        "entitlement_reconcile.subscription.failed",
      );
      summary.errors.push({ subscriptionId: sub.id, error: message });
    }
  }

  logger.info(
    {
      scanned: summary.scanned,
      refreshed: summary.refreshed.length,
      noOp: summary.noOp,
      skipped: summary.skipped,
      errors: summary.errors.length,
      runAt: now.toISOString(),
    },
    "entitlement_reconcile.completed",
  );

  return summary;
}
