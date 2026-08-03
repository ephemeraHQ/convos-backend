import { OfferType } from "@apple/app-store-server-library";
import { SubscriptionStatus } from "@prisma/client";
import { describe, expect, test } from "vitest";
import {
  deriveSubscriptionStatusFromTransaction,
  effectiveSubscriptionStatus,
  effectiveSubscriptionStatusForDisplay,
  isEntitledSubscription,
  isEntitledSubscriptionForDisplay,
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

describe("effectiveSubscriptionStatusForDisplay (CON-799)", () => {
  // The bug: an auto-renewing Plus subscriber whose renewal webhook was
  // late/dropped (currentPeriodEnd slipped into the past while status is still
  // `active`) was framed as free-tier/Basic. Display entitlement must keep them
  // entitled until an explicit terminal signal, while the strict money variant
  // (effectiveSubscriptionStatus) still time-expires them.
  test("auto-renewing active sub past its period stays entitled for display", () => {
    const subscription = {
      status: SubscriptionStatus.active,
      currentPeriodEnd: new Date("2026-05-14T23:59:59.000Z"),
      gracePeriodEnd: null,
      willRenew: true,
    };

    // Strict/money view still time-expires it (grant backfill must not mint).
    expect(effectiveSubscriptionStatus(subscription, now)).toBe(
      SubscriptionStatus.expired,
    );
    expect(isEntitledSubscription(subscription, now)).toBe(false);

    // Display view keeps the stored entitled status → tier framing, not Basic.
    expect(effectiveSubscriptionStatusForDisplay(subscription, now)).toBe(
      SubscriptionStatus.active,
    );
    expect(isEntitledSubscriptionForDisplay(subscription, now)).toBe(true);
  });

  test("auto-renewing trial past its period stays entitled for display", () => {
    const subscription = {
      status: SubscriptionStatus.trial,
      currentPeriodEnd: new Date("2026-05-14T23:59:59.000Z"),
      gracePeriodEnd: null,
      willRenew: true,
    };

    expect(effectiveSubscriptionStatusForDisplay(subscription, now)).toBe(
      SubscriptionStatus.trial,
    );
    expect(isEntitledSubscriptionForDisplay(subscription, now)).toBe(true);
  });

  test("cancelled (willRenew=false) active sub past its period is expired for display too", () => {
    const subscription = {
      status: SubscriptionStatus.active,
      currentPeriodEnd: new Date("2026-05-14T23:59:59.000Z"),
      gracePeriodEnd: null,
      willRenew: false,
    };

    expect(effectiveSubscriptionStatusForDisplay(subscription, now)).toBe(
      SubscriptionStatus.expired,
    );
    expect(isEntitledSubscriptionForDisplay(subscription, now)).toBe(false);
  });

  test("provider-expired sub is terminal for display regardless of willRenew", () => {
    const subscription = {
      status: SubscriptionStatus.expired,
      currentPeriodEnd: new Date("2026-05-14T23:59:59.000Z"),
      gracePeriodEnd: null,
      willRenew: true,
    };

    expect(effectiveSubscriptionStatusForDisplay(subscription, now)).toBe(
      SubscriptionStatus.expired,
    );
    expect(isEntitledSubscriptionForDisplay(subscription, now)).toBe(false);
  });

  test("within-period auto-renewing sub is entitled for display (unchanged)", () => {
    const subscription = {
      status: SubscriptionStatus.active,
      currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
      gracePeriodEnd: null,
      willRenew: true,
    };

    expect(effectiveSubscriptionStatusForDisplay(subscription, now)).toBe(
      SubscriptionStatus.active,
    );
    expect(isEntitledSubscriptionForDisplay(subscription, now)).toBe(true);
  });
});
