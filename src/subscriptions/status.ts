import {
  OfferType,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import { SubscriptionStatus, type Subscription } from "@prisma/client";

export const ENTITLED_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.trial,
  SubscriptionStatus.active,
  SubscriptionStatus.grace,
  SubscriptionStatus.billingRetry,
];

export const isEntitledSubscriptionStatus = (
  status: SubscriptionStatus,
): boolean => ENTITLED_SUBSCRIPTION_STATUSES.includes(status);

const dateMillis = (value: Date | number | string | undefined | null) => {
  if (value === undefined || value === null) return null;
  const ms =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

export const deriveSubscriptionStatusFromTransaction = (
  payload: JWSTransactionDecodedPayload,
  now: Date = new Date(),
): SubscriptionStatus => {
  if (payload.revocationDate) return SubscriptionStatus.revoked;

  const expiresAt = dateMillis(payload.expiresDate);
  if (expiresAt !== null && expiresAt <= now.getTime()) {
    return SubscriptionStatus.expired;
  }

  if (payload.offerType === OfferType.INTRODUCTORY_OFFER) {
    return SubscriptionStatus.trial;
  }

  return SubscriptionStatus.active;
};

type SubscriptionEntitlementFields = Pick<
  Subscription,
  "status" | "currentPeriodEnd" | "gracePeriodEnd"
>;

export const effectiveSubscriptionStatus = (
  subscription: SubscriptionEntitlementFields,
  now: Date = new Date(),
): SubscriptionStatus => {
  if (
    subscription.status === SubscriptionStatus.expired ||
    subscription.status === SubscriptionStatus.revoked
  ) {
    return subscription.status;
  }

  const nowMs = now.getTime();
  if (
    (subscription.status === SubscriptionStatus.active ||
      subscription.status === SubscriptionStatus.trial) &&
    subscription.currentPeriodEnd.getTime() <= nowMs
  ) {
    return SubscriptionStatus.expired;
  }

  if (subscription.status === SubscriptionStatus.grace) {
    const graceEnd =
      subscription.gracePeriodEnd ?? subscription.currentPeriodEnd;
    if (graceEnd.getTime() <= nowMs) {
      return SubscriptionStatus.expired;
    }
  }

  // TODO(v1.1): billingRetry has no TTL here — Apple's billing retry window
  // is up to 60 days, after which they send EXPIRED. If that final webhook
  // is dropped (network, mis-config, Apple delay), this status persists and
  // the user stays entitled indefinitely. The Phase 7 reconciliation
  // worker is the intended safety net, but adding a billingRetryEndsAt
  // column + a `nowMs > billingRetryEndsAt` check here would be a
  // self-contained backstop. Not pre-merge-blocking: real billing retries
  // resolve within hours/days for the vast majority of customers.

  return subscription.status;
};

export const isEntitledSubscription = (
  subscription: SubscriptionEntitlementFields,
  now: Date = new Date(),
): boolean =>
  isEntitledSubscriptionStatus(effectiveSubscriptionStatus(subscription, now));

type SubscriptionDisplayEntitlementFields = SubscriptionEntitlementFields &
  Pick<Subscription, "willRenew">;

/**
 * Display/framing-facing effective status. Identical to
 * `effectiveSubscriptionStatus` EXCEPT it does NOT flip an auto-renewing
 * (`willRenew`) `active`/`trial` subscription to `expired` the instant
 * `currentPeriodEnd` passes.
 *
 * Rationale (CON-799): for an auto-renewing subscription, a `currentPeriodEnd`
 * that has slipped into the past means the renewal (Apple `DID_RENEW` / Play
 * equivalent) webhook is late or was dropped — NOT that the paying subscriber
 * lost entitlement. Framing them as free-tier/Basic in that window is the bug.
 * The terminal signal for an auto-renewing sub is an explicit provider
 * notification that moves the STORED status to `expired`/`revoked` (or a
 * `grace` window whose `gracePeriodEnd` then passes), which this function still
 * honors. A CANCELLED sub (`willRenew === false`) that simply runs out its
 * period is genuinely lapsed and still resolves to `expired` → free-tier
 * framing, so cancelled users are unaffected.
 *
 * WHY THIS IS SEPARATE from `effectiveSubscriptionStatus`: the money paths —
 * specifically the verify-replay `sub_grant` backfill in
 * `subscriptions/repository.ts` — deliberately use the strict, time-based
 * `isEntitledSubscription`/`effectiveSubscriptionStatus` so they never MINT a
 * period grant for a stored period whose window has already elapsed. That
 * behavior must not change. This variant is for READ/DISPLAY framing only
 * (`GET /credits`, `GET /subscription`/badge, and the credits-admin view),
 * where an entitled-but-renewal-pending (and possibly balance-exhausted)
 * subscriber must keep tier framing at zero remaining instead of dropping to
 * Basic / the free-tier daily cap.
 *
 * The deferral is BOUNDED by `DISPLAY_RENEWAL_GRACE_MS`: a real webhook gap
 * resolves within Apple/Google's delivery-and-retry window (hours, not weeks),
 * so past the bound a stale `willRenew=true` row is treated as lapsed rather
 * than renewal-pending. Unbounded deferral would let rows whose terminal
 * webhook we permanently missed (e.g. every cancellation/expiry event fired
 * before 2026-07-29, when the prod App Store Server Notifications URL was
 * first configured — Apple does not resend those) display the paid tier
 * forever. The residual in-window risk mirrors the already-accepted,
 * documented tradeoff for `billingRetry` above.
 */
export const DISPLAY_RENEWAL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export const effectiveSubscriptionStatusForDisplay = (
  subscription: SubscriptionDisplayEntitlementFields,
  now: Date = new Date(),
): SubscriptionStatus => {
  const periodEndMs = subscription.currentPeriodEnd.getTime();
  if (
    (subscription.status === SubscriptionStatus.active ||
      subscription.status === SubscriptionStatus.trial) &&
    subscription.willRenew &&
    periodEndMs <= now.getTime() &&
    now.getTime() < periodEndMs + DISPLAY_RENEWAL_GRACE_MS
  ) {
    // Renewal pending — keep the stored (entitled) status rather than
    // time-expiring it. A terminal provider webhook (or the grace bound
    // above elapsing) is the only downgrade.
    return subscription.status;
  }
  return effectiveSubscriptionStatus(subscription, now);
};

export const isEntitledSubscriptionForDisplay = (
  subscription: SubscriptionDisplayEntitlementFields,
  now: Date = new Date(),
): boolean =>
  isEntitledSubscriptionStatus(
    effectiveSubscriptionStatusForDisplay(subscription, now),
  );
