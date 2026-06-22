import { OfferType } from "@apple/app-store-server-library";
import { SubscriptionStatus } from "@prisma/client";
import { describe, expect, test } from "vitest";
import {
  deriveSubscriptionStatusFromTransaction,
  effectiveSubscriptionStatus,
  isEntitledSubscription,
} from "@/subscriptions/status";

const now = new Date("2026-05-15T00:00:00.000Z");

describe("deriveSubscriptionStatusFromTransaction", () => {
  test("revocation wins over other state", () => {
    expect(
      deriveSubscriptionStatusFromTransaction(
        {
          revocationDate: now.getTime(),
          expiresDate: new Date("2026-06-01T00:00:00.000Z").getTime(),
          offerType: OfferType.INTRODUCTORY_OFFER,
        },
        now,
      ),
    ).toBe(SubscriptionStatus.revoked);
  });

  test("past expiresDate is expired, not trial", () => {
    expect(
      deriveSubscriptionStatusFromTransaction(
        {
          expiresDate: new Date("2026-05-14T23:59:59.000Z").getTime(),
          offerType: OfferType.INTRODUCTORY_OFFER,
        },
        now,
      ),
    ).toBe(SubscriptionStatus.expired);
  });

  test("future introductory offer is trial", () => {
    expect(
      deriveSubscriptionStatusFromTransaction(
        {
          expiresDate: new Date("2026-06-01T00:00:00.000Z").getTime(),
          offerType: OfferType.INTRODUCTORY_OFFER,
        },
        now,
      ),
    ).toBe(SubscriptionStatus.trial);
  });
});

describe("effectiveSubscriptionStatus", () => {
  test("past-ended active subscription is effectively expired", () => {
    const subscription = {
      status: SubscriptionStatus.active,
      currentPeriodEnd: new Date("2026-05-14T23:59:59.000Z"),
      gracePeriodEnd: null,
    };

    expect(effectiveSubscriptionStatus(subscription, now)).toBe(
      SubscriptionStatus.expired,
    );
    expect(isEntitledSubscription(subscription, now)).toBe(false);
  });

  test("future active subscription remains entitled", () => {
    const subscription = {
      status: SubscriptionStatus.active,
      currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
      gracePeriodEnd: null,
    };

    expect(effectiveSubscriptionStatus(subscription, now)).toBe(
      SubscriptionStatus.active,
    );
    expect(isEntitledSubscription(subscription, now)).toBe(true);
  });

  describe("grace entitlement (governed by gracePeriodEnd)", () => {
    test("within gracePeriodEnd (even with a lapsed currentPeriodEnd) → entitled", () => {
      const subscription = {
        status: SubscriptionStatus.grace,
        // Paid period ended, but the store reported a future grace deadline.
        currentPeriodEnd: new Date("2026-05-01T00:00:00.000Z"),
        gracePeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
      };

      expect(effectiveSubscriptionStatus(subscription, now)).toBe(
        SubscriptionStatus.grace,
      );
      expect(isEntitledSubscription(subscription, now)).toBe(true);
    });

    test("past gracePeriodEnd → expired (not entitled)", () => {
      const subscription = {
        status: SubscriptionStatus.grace,
        currentPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
        // Grace window closed before `now`.
        gracePeriodEnd: new Date("2026-05-14T23:59:59.000Z"),
      };

      expect(effectiveSubscriptionStatus(subscription, now)).toBe(
        SubscriptionStatus.expired,
      );
      expect(isEntitledSubscription(subscription, now)).toBe(false);
    });

    test("exactly at gracePeriodEnd → expired (boundary inclusive)", () => {
      const subscription = {
        status: SubscriptionStatus.grace,
        currentPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
        gracePeriodEnd: now,
      };

      expect(effectiveSubscriptionStatus(subscription, now)).toBe(
        SubscriptionStatus.expired,
      );
      expect(isEntitledSubscription(subscription, now)).toBe(false);
    });

    test("null gracePeriodEnd falls back to currentPeriodEnd — future → entitled", () => {
      const subscription = {
        status: SubscriptionStatus.grace,
        currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
        gracePeriodEnd: null,
      };

      expect(effectiveSubscriptionStatus(subscription, now)).toBe(
        SubscriptionStatus.grace,
      );
      expect(isEntitledSubscription(subscription, now)).toBe(true);
    });

    test("null gracePeriodEnd falls back to currentPeriodEnd — past → expired", () => {
      const subscription = {
        status: SubscriptionStatus.grace,
        currentPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
        gracePeriodEnd: null,
      };

      expect(effectiveSubscriptionStatus(subscription, now)).toBe(
        SubscriptionStatus.expired,
      );
      expect(isEntitledSubscription(subscription, now)).toBe(false);
    });
  });

  describe("billingRetry is governed by currentPeriodEnd (no grace window)", () => {
    test("within currentPeriodEnd → entitled (still inside the paid period)", () => {
      const subscription = {
        status: SubscriptionStatus.billingRetry,
        currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
        gracePeriodEnd: null,
      };

      expect(effectiveSubscriptionStatus(subscription, now)).toBe(
        SubscriptionStatus.billingRetry,
      );
      expect(isEntitledSubscription(subscription, now)).toBe(true);
    });

    test("past currentPeriodEnd → expired (NOT entitled; retry window is not extended access)", () => {
      const subscription = {
        status: SubscriptionStatus.billingRetry,
        currentPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
        gracePeriodEnd: null,
      };

      expect(effectiveSubscriptionStatus(subscription, now)).toBe(
        SubscriptionStatus.expired,
      );
      expect(isEntitledSubscription(subscription, now)).toBe(false);
    });

    test("a stale future gracePeriodEnd does NOT keep a billingRetry row entitled past currentPeriodEnd", () => {
      // Defense in depth: even if a stale grace deadline survived (it shouldn't,
      // B-N2 nulls it), billingRetry is governed by currentPeriodEnd, not grace.
      const subscription = {
        status: SubscriptionStatus.billingRetry,
        currentPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
        gracePeriodEnd: new Date("2026-07-01T00:00:00.000Z"),
      };

      expect(effectiveSubscriptionStatus(subscription, now)).toBe(
        SubscriptionStatus.expired,
      );
      expect(isEntitledSubscription(subscription, now)).toBe(false);
    });
  });
});
