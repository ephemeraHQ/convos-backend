import { SubscriptionPeriod } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { tierGrant } from "@/subscriptions/tier-config";
import { SUBSCRIPTION_TIER_PLUS } from "@/subscriptions/tiers";

const snap = () => ({
  plus: process.env.PAYMENTS_GRANT_PLUS_MONTHLY,
});

const restore = (s: { plus: string | undefined }) => {
  if (s.plus === undefined) {
    delete process.env.PAYMENTS_GRANT_PLUS_MONTHLY;
  } else {
    process.env.PAYMENTS_GRANT_PLUS_MONTHLY = s.plus;
  }
};

describe("tierGrant", () => {
  let s: ReturnType<typeof snap>;

  beforeEach(() => {
    s = snap();
    process.env.PAYMENTS_GRANT_PLUS_MONTHLY = "2500";
  });

  afterEach(() => {
    restore(s);
  });

  test("plus monthly → 2500", () => {
    expect(
      tierGrant(SUBSCRIPTION_TIER_PLUS, SubscriptionPeriod.monthly).perPeriod,
    ).toBe(2500);
  });

  test("plus annual → 12 × monthly", () => {
    expect(
      tierGrant(SUBSCRIPTION_TIER_PLUS, SubscriptionPeriod.annual).perPeriod,
    ).toBe(2500 * 12);
  });

  test("missing PAYMENTS_GRANT_PLUS_MONTHLY throws 500", () => {
    delete process.env.PAYMENTS_GRANT_PLUS_MONTHLY;
    expect(() =>
      tierGrant(SUBSCRIPTION_TIER_PLUS, SubscriptionPeriod.monthly),
    ).toThrow(/PAYMENTS_GRANT_PLUS_MONTHLY/);
  });

  test("non-positive value throws", () => {
    process.env.PAYMENTS_GRANT_PLUS_MONTHLY = "0";
    expect(() =>
      tierGrant(SUBSCRIPTION_TIER_PLUS, SubscriptionPeriod.monthly),
    ).toThrow(/positive integer/);
  });

  test("non-numeric throws", () => {
    process.env.PAYMENTS_GRANT_PLUS_MONTHLY = "lots";
    expect(() =>
      tierGrant(SUBSCRIPTION_TIER_PLUS, SubscriptionPeriod.monthly),
    ).toThrow(/positive integer/);
  });
});
