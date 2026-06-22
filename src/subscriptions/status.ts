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
  // active/trial AND billingRetry are governed by the paid period: entitled
  // only while `now <= currentPeriodEnd`. For billingRetry this is the contract
  // (Apple status=3, Google onHold/paused are NOT entitled past the paid period
  // — the retry/hold window is the provider's internal schedule, not extended
  // access) and it is the backstop against an "entitled forever" row if the
  // final EXPIRED webhook is dropped. The Phase 7 reconciliation worker is the
  // secondary safety net. Grace is the ONLY status that extends access past
  // currentPeriodEnd, governed below by gracePeriodEnd.
  if (
    (subscription.status === SubscriptionStatus.active ||
      subscription.status === SubscriptionStatus.trial ||
      subscription.status === SubscriptionStatus.billingRetry) &&
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

  return subscription.status;
};

export const isEntitledSubscription = (
  subscription: SubscriptionEntitlementFields,
  now: Date = new Date(),
): boolean =>
  isEntitledSubscriptionStatus(effectiveSubscriptionStatus(subscription, now));
