import { OfferType } from "@apple/app-store-server-library";
import { SubscriptionStatus } from "@prisma/client";
import { describe, expect, test } from "bun:test";
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
});
