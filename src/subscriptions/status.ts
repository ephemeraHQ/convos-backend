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
