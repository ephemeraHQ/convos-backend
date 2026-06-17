import { SubscriptionStatus } from "@prisma/client";
import { describe, expect, test } from "vitest";
import {
  mapNotificationToUpdate,
  PlayNotificationType,
} from "@/subscriptions/google-play/notification-mapping";
import type { SubscriptionPurchaseV2 } from "@/subscriptions/google-play/play-api";
import { PlaySubscriptionState } from "@/subscriptions/google-play/status";

const purchase = (
  overrides: Partial<SubscriptionPurchaseV2>,
): SubscriptionPurchaseV2 => ({
  subscriptionState: PlaySubscriptionState.active,
  startTime: "2026-05-01T00:00:00.000Z",
  lineItems: [
    {
      productId: "app.convos.subs.builder.monthly",
      expiryTime: "2026-06-01T00:00:00.000Z",
      autoRenewingPlan: { autoRenewEnabled: true },
    },
  ],
  ...overrides,
});

const NOW = new Date("2026-05-15T00:00:00.000Z");

describe("mapNotificationToUpdate", () => {
  test("RENEWED → active + new window + willRenew true", () => {
    const result = mapNotificationToUpdate({
      notificationType: PlayNotificationType.renewed,
      purchase: purchase({}),
      now: NOW,
    });
    expect(result).toMatchObject({
      status: SubscriptionStatus.active,
      willRenew: true,
      cancelledAt: null,
      gracePeriodEnd: null,
    });
    expect(result?.currentPeriodEnd?.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });

  test("CANCELED → willRenew false + cancelledAt = now (status still active until expiry)", () => {
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();
    const result = mapNotificationToUpdate({
      notificationType: PlayNotificationType.canceled,
      purchase: purchase({
        subscriptionState: PlaySubscriptionState.cancelled,
        lineItems: [
          {
            productId: "app.convos.subs.builder.monthly",
            expiryTime: future,
          },
        ],
      }),
      now: NOW,
    });
    expect(result?.status).toBe(SubscriptionStatus.active);
    expect(result?.willRenew).toBe(false);
    expect(result?.cancelledAt?.toISOString()).toBe(NOW.toISOString());
  });

  test("PURCHASED returns null (cold-start branch)", () => {
    expect(
      mapNotificationToUpdate({
        notificationType: PlayNotificationType.purchased,
        purchase: purchase({}),
        now: NOW,
      }),
    ).toBeNull();
  });

  test("ON_HOLD → billingRetry", () => {
    expect(
      mapNotificationToUpdate({
        notificationType: PlayNotificationType.onHold,
        purchase: purchase({}),
        now: NOW,
      }),
    ).toMatchObject({
      status: SubscriptionStatus.billingRetry,
      willRenew: false,
    });
  });

  test("IN_GRACE_PERIOD → grace + gracePeriodEnd set", () => {
    const result = mapNotificationToUpdate({
      notificationType: PlayNotificationType.inGracePeriod,
      purchase: purchase({}),
      now: NOW,
    });
    expect(result?.status).toBe(SubscriptionStatus.grace);
    expect(result?.gracePeriodEnd?.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });

  test("REVOKED → revoked + willRenew false + cancelledAt now", () => {
    const result = mapNotificationToUpdate({
      notificationType: PlayNotificationType.revoked,
      purchase: purchase({}),
      now: NOW,
    });
    expect(result?.status).toBe(SubscriptionStatus.revoked);
    expect(result?.willRenew).toBe(false);
    expect(result?.cancelledAt?.toISOString()).toBe(NOW.toISOString());
  });

  test("EXPIRED → expired + clear gracePeriodEnd", () => {
    expect(
      mapNotificationToUpdate({
        notificationType: PlayNotificationType.expired,
        purchase: purchase({}),
        now: NOW,
      }),
    ).toMatchObject({
      status: SubscriptionStatus.expired,
      willRenew: false,
      gracePeriodEnd: null,
    });
  });

  test("PRICE_CHANGE_CONFIRMED, PAUSE_SCHEDULE_CHANGED, PENDING_PURCHASE_CANCELED → null (audit only)", () => {
    for (const t of [
      PlayNotificationType.priceChangeConfirmed,
      PlayNotificationType.pauseScheduleChanged,
      PlayNotificationType.pendingPurchaseCanceled,
    ]) {
      expect(
        mapNotificationToUpdate({
          notificationType: t,
          purchase: purchase({}),
          now: NOW,
        }),
      ).toBeNull();
    }
  });

  test("DEFERRED updates currentPeriodEnd only", () => {
    const result = mapNotificationToUpdate({
      notificationType: PlayNotificationType.deferred,
      purchase: purchase({}),
      now: NOW,
    });
    expect(Object.keys(result ?? {})).toEqual(["currentPeriodEnd"]);
  });

  test("RECOVERED + RESTARTED both clear cancellation and set willRenew=true", () => {
    for (const t of [
      PlayNotificationType.recovered,
      PlayNotificationType.restarted,
    ]) {
      expect(
        mapNotificationToUpdate({
          notificationType: t,
          purchase: purchase({}),
          now: NOW,
        }),
      ).toMatchObject({
        willRenew: true,
        cancelledAt: null,
        gracePeriodEnd: null,
      });
    }
  });
});
