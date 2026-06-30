import {
  NotificationTypeV2,
  Subtype,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import { productMapping } from "@/subscriptions/product-mapping";
import {
  SubscriptionStatus,
  type NotificationStateUpdate,
  type SubscriptionPeriod,
  type SubscriptionTier,
} from "@/subscriptions/repository";
import { deriveSubscriptionStatusFromTransaction } from "@/subscriptions/status";

type Input = {
  notificationType: string | undefined;
  subtype: string | undefined | null;
  transaction: JWSTransactionDecodedPayload;
};

/**
 * Decode an Apple S2S notification into the subscription state diff it
 * implies. Returns null when the notification carries no actionable state
 * change (TEST, CONSUMPTION_REQUEST, unknown types) — the caller still
 * records the receipt for audit, but skips the Subscription update.
 *
 * Reference: PRD §6.3.
 */
export const mapNotificationToUpdate = (
  input: Input,
): NotificationStateUpdate | null => {
  const { transaction } = input;

  const periodWindow = (() => {
    if (!transaction.purchaseDate || !transaction.expiresDate) return {};
    return {
      currentPeriodStart: new Date(transaction.purchaseDate),
      currentPeriodEnd: new Date(transaction.expiresDate),
    };
  })();

  // Unknown SKU (deprecated product, drift between App Store Connect and the
  // backend, or a notification type that doesn't carry an actionable
  // product) must not crash the webhook — Apple would retry indefinitely.
  // Return null and let the per-case switch decide whether to skip the
  // update (DID_CHANGE_RENEWAL_PREF) or apply the rest of the diff without
  // tier fields (SUBSCRIBED/DID_RENEW). The receipt is still recorded for
  // audit either way.
  const tierAndPeriod: {
    tier: SubscriptionTier;
    period: SubscriptionPeriod;
    productId: string;
  } | null = (() => {
    if (!transaction.productId) return null;
    try {
      const { tier, period } = productMapping(transaction.productId);
      return { tier, period, productId: transaction.productId };
    } catch {
      return null;
    }
  })();

  switch (input.notificationType) {
    case NotificationTypeV2.SUBSCRIBED:
    case NotificationTypeV2.DID_RENEW: {
      const status = deriveSubscriptionStatusFromTransaction(transaction);
      return {
        ...(tierAndPeriod ?? {}),
        ...periodWindow,
        status,
        isInTrial: status === SubscriptionStatus.trial,
        willRenew: true,
        cancelledAt: null,
        gracePeriodEnd: null,
      };
    }

    case NotificationTypeV2.DID_FAIL_TO_RENEW:
      if (input.subtype === Subtype.GRACE_PERIOD) {
        return {
          status: SubscriptionStatus.grace,
          ...(transaction.expiresDate
            ? { gracePeriodEnd: new Date(transaction.expiresDate) }
            : {}),
        };
      }
      // No subtype, or BILLING_RETRY → user is in retry, not in grace.
      return { status: SubscriptionStatus.billingRetry };

    case NotificationTypeV2.GRACE_PERIOD_EXPIRED:
    case NotificationTypeV2.EXPIRED:
      return {
        // Carry the period this terminal event is about so applyNotification's
        // staleness guard can drop an out-of-order EXPIRED for a period a later
        // renewal already superseded (instead of clobbering the active row).
        ...(transaction.expiresDate
          ? { currentPeriodEnd: new Date(transaction.expiresDate) }
          : {}),
        status: SubscriptionStatus.expired,
        willRenew: false,
        gracePeriodEnd: null,
      };

    case NotificationTypeV2.REVOKE:
    case NotificationTypeV2.REFUND:
      return {
        // Same staleness signal as EXPIRED: a legit mid-period refund/revoke
        // carries the current period's end (>= stored) and applies + forfeits;
        // a stale old-period one (< stored) is skipped by the guard.
        ...(transaction.expiresDate
          ? { currentPeriodEnd: new Date(transaction.expiresDate) }
          : {}),
        status: SubscriptionStatus.revoked,
        willRenew: false,
        cancelledAt: new Date(transaction.signedDate ?? Date.now()),
      };

    case NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS:
      // AUTO_RENEW_DISABLED / AUTO_RENEW_ENABLED tells us the renewal flag flipped.
      return {
        willRenew: input.subtype === Subtype.AUTO_RENEW_ENABLED,
      };

    case NotificationTypeV2.DID_CHANGE_RENEWAL_PREF:
      // Tier upgrade/downgrade — productId carries the new tier. Without
      // a recognized productId there is no state change to apply; return
      // null so the caller skips the Subscription update entirely (still
      // acks the receipt for audit) instead of writing an empty update
      // that just bumps updatedAt.
      if (!tierAndPeriod) return null;
      return tierAndPeriod;

    case NotificationTypeV2.PRICE_INCREASE:
    case NotificationTypeV2.PRICE_CHANGE:
    case NotificationTypeV2.OFFER_REDEEMED:
    case NotificationTypeV2.RENEWAL_EXTENDED:
    case NotificationTypeV2.RENEWAL_EXTENSION:
    case NotificationTypeV2.REFUND_DECLINED:
    case NotificationTypeV2.REFUND_REVERSED:
    case NotificationTypeV2.CONSUMPTION_REQUEST:
    case NotificationTypeV2.TEST:
    case NotificationTypeV2.METADATA_UPDATE:
    case NotificationTypeV2.MIGRATION:
    case NotificationTypeV2.EXTERNAL_PURCHASE_TOKEN:
    case NotificationTypeV2.ONE_TIME_CHARGE:
    case NotificationTypeV2.RESCIND_CONSENT:
      return null;

    default:
      return null;
  }
};
