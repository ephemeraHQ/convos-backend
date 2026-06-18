import { SubscriptionStatus } from "@prisma/client";
import type { NotificationStateUpdate } from "@/subscriptions/repository";
import type { SubscriptionPurchaseV2 } from "./play-api";
import { deriveStatusFromPurchase, extractPeriodWindow } from "./status";

/**
 * Google's RTDN `subscriptionNotification.notificationType` values. Stable
 * integers per https://developer.android.com/google/play/billing/rtdn-reference.
 */
export const PlayNotificationType = {
  recovered: 1,
  renewed: 2,
  canceled: 3,
  purchased: 4,
  onHold: 5,
  inGracePeriod: 6,
  restarted: 7,
  priceChangeConfirmed: 8,
  deferred: 9,
  paused: 10,
  pauseScheduleChanged: 11,
  revoked: 12,
  expired: 13,
  pendingPurchaseCanceled: 20,
} as const;

export type PlayNotificationMappingInput = {
  notificationType: number;
  purchase: SubscriptionPurchaseV2;
  now?: Date;
};

/**
 * Map an RTDN notificationType + the authoritative fetched purchase into a
 * Subscription state update. The notificationType tells us *why* to refresh;
 * the fetched purchase is the source of truth for *what* to write.
 *
 * Returns null when the notification is informational (no state change) or
 * cold-start (handler routes to ack-and-wait-for-verify).
 */
export const mapNotificationToUpdate = (
  input: PlayNotificationMappingInput,
): NotificationStateUpdate | null => {
  const now = input.now ?? new Date();
  switch (input.notificationType) {
    case PlayNotificationType.recovered:
    case PlayNotificationType.renewed:
    case PlayNotificationType.restarted: {
      const window = extractPeriodWindow(input.purchase);
      return {
        status: deriveStatusFromPurchase(input.purchase, now),
        currentPeriodStart: window.currentPeriodStart,
        currentPeriodEnd: window.currentPeriodEnd,
        willRenew: true,
        cancelledAt: null,
        gracePeriodEnd: null,
      };
    }
    case PlayNotificationType.canceled: {
      const window = extractPeriodWindow(input.purchase);
      return {
        status: deriveStatusFromPurchase(input.purchase, now),
        currentPeriodEnd: window.currentPeriodEnd,
        willRenew: false,
        cancelledAt: now,
      };
    }
    case PlayNotificationType.purchased:
      // Cold start: /verify will create the row from the same purchaseToken.
      // Handler returns 200 without touching state.
      return null;
    case PlayNotificationType.onHold:
      return { status: SubscriptionStatus.billingRetry, willRenew: false };
    case PlayNotificationType.inGracePeriod: {
      const window = extractPeriodWindow(input.purchase);
      return {
        status: SubscriptionStatus.grace,
        gracePeriodEnd: window.currentPeriodEnd,
      };
    }
    case PlayNotificationType.priceChangeConfirmed:
      // Audit-only. No state change.
      return null;
    case PlayNotificationType.deferred: {
      const window = extractPeriodWindow(input.purchase);
      return { currentPeriodEnd: window.currentPeriodEnd };
    }
    case PlayNotificationType.paused:
      return { status: SubscriptionStatus.billingRetry };
    case PlayNotificationType.pauseScheduleChanged:
      return null;
    case PlayNotificationType.revoked:
      return {
        status: SubscriptionStatus.revoked,
        willRenew: false,
        cancelledAt: now,
      };
    case PlayNotificationType.expired:
      return {
        status: SubscriptionStatus.expired,
        willRenew: false,
        gracePeriodEnd: null,
      };
    case PlayNotificationType.pendingPurchaseCanceled:
      return null;
    default:
      // Unknown future type — log + ack at handler level.
      return null;
  }
};
