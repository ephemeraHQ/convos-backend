import { SubscriptionStatus } from "@prisma/client";
import { AppError } from "@/utils/errors";
import type { SubscriptionPurchaseV2 } from "./play-api";

/**
 * SubscriptionPurchaseV2.subscriptionState enum values from the Play
 * Developer API. Stable strings, but kept here as a typed enum to avoid
 * stringly-typed branches.
 */
export const PlaySubscriptionState = {
  unspecified: "SUBSCRIPTION_STATE_UNSPECIFIED",
  active: "SUBSCRIPTION_STATE_ACTIVE",
  cancelled: "SUBSCRIPTION_STATE_CANCELED",
  inGracePeriod: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  onHold: "SUBSCRIPTION_STATE_ON_HOLD",
  paused: "SUBSCRIPTION_STATE_PAUSED",
  expired: "SUBSCRIPTION_STATE_EXPIRED",
  pending: "SUBSCRIPTION_STATE_PENDING",
} as const;

const activeLineItem = (purchase: SubscriptionPurchaseV2) => {
  const items = purchase.lineItems ?? [];
  if (items.length === 0) {
    throw new AppError(400, "Google Play purchase has no lineItems");
  }
  return items[0];
};

const isTrialOffer = (purchase: SubscriptionPurchaseV2): boolean => {
  const item = activeLineItem(purchase);
  const tags = item.offerDetails?.offerTags ?? [];
  // "free_trial" is the conventional tag Convos adds in Play Console for
  // introductory free-trial offers; treat any tag containing "trial" as a
  // signal so we don't depend on exact casing.
  return tags.some((t) => t.toLowerCase().includes("trial"));
};

export const deriveStatusFromPurchase = (
  purchase: SubscriptionPurchaseV2,
  now: Date = new Date(),
): SubscriptionStatus => {
  const state = purchase.subscriptionState;
  switch (state) {
    case PlaySubscriptionState.active:
      return isTrialOffer(purchase)
        ? SubscriptionStatus.trial
        : SubscriptionStatus.active;
    case PlaySubscriptionState.inGracePeriod:
      return SubscriptionStatus.grace;
    case PlaySubscriptionState.onHold:
      return SubscriptionStatus.billingRetry;
    case PlaySubscriptionState.paused:
      // Convos has no `paused` enum value. Treat a paused subscription as
      // billingRetry so entitlement is suspended without losing the row.
      return SubscriptionStatus.billingRetry;
    case PlaySubscriptionState.expired:
      return SubscriptionStatus.expired;
    case PlaySubscriptionState.cancelled: {
      const window = extractPeriodWindow(purchase);
      if (window.currentPeriodEnd.getTime() <= now.getTime()) {
        return SubscriptionStatus.expired;
      }
      // Cancelling auto-renew during a free trial should not strip the trial
      // status for the remainder of the trial window.
      return isTrialOffer(purchase)
        ? SubscriptionStatus.trial
        : SubscriptionStatus.active;
    }
    case PlaySubscriptionState.pending:
      throw new AppError(
        400,
        "Google Play purchase is pending; verify must not persist pending purchases",
      );
    default:
      throw new AppError(
        400,
        `Unknown Google Play subscriptionState: ${state ?? "<none>"}`,
      );
  }
};

export const extractPeriodWindow = (
  purchase: SubscriptionPurchaseV2,
): { currentPeriodStart: Date; currentPeriodEnd: Date } => {
  const item = activeLineItem(purchase);
  const expiry = item.expiryTime;
  if (!expiry) {
    throw new AppError(400, "Google Play lineItem missing expiryTime");
  }
  const start = purchase.startTime ?? expiry;
  return {
    currentPeriodStart: new Date(start),
    currentPeriodEnd: new Date(expiry),
  };
};

export const extractProductId = (purchase: SubscriptionPurchaseV2): string => {
  const item = activeLineItem(purchase);
  if (!item.productId) {
    throw new AppError(400, "Google Play lineItem missing productId");
  }
  return item.productId;
};

export const extractObfuscatedAccountId = (
  purchase: SubscriptionPurchaseV2,
): string | null =>
  purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null;
