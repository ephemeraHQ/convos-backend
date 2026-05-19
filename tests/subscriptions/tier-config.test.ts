import { SubscriptionPeriod, SubscriptionTier } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tierGrant } from "@/subscriptions/tier-config";

const snap = () => ({
  builder: process.env.PAYMENTS_GRANT_BUILDER_MONTHLY,
  pro: process.env.PAYMENTS_GRANT_PRO_MONTHLY,
});

const restore = (s: {
  builder: string | undefined;
  pro: string | undefined;
}) => {
  if (s.builder === undefined) {
    delete process.env.PAYMENTS_GRANT_BUILDER_MONTHLY;
  } else {
    process.env.PAYMENTS_GRANT_BUILDER_MONTHLY = s.builder;
  }
  if (s.pro === undefined) {
    delete process.env.PAYMENTS_GRANT_PRO_MONTHLY;
  } else {
    process.env.PAYMENTS_GRANT_PRO_MONTHLY = s.pro;
  }
};

describe("tierGrant", () => {
  let s: ReturnType<typeof snap>;

  beforeEach(() => {
    s = snap();
    process.env.PAYMENTS_GRANT_BUILDER_MONTHLY = "2500";
    process.env.PAYMENTS_GRANT_PRO_MONTHLY = "10000";
  });

  afterEach(() => {
    restore(s);
  });

  test("builder monthly → 2500", () => {
    expect(
      tierGrant(SubscriptionTier.builder, SubscriptionPeriod.monthly).perPeriod,
    ).toBe(2500);
  });

  test("pro monthly → 10000", () => {
    expect(
      tierGrant(SubscriptionTier.pro, SubscriptionPeriod.monthly).perPeriod,
    ).toBe(10000);
  });

  test("builder annual → 12 × monthly", () => {
    expect(
      tierGrant(SubscriptionTier.builder, SubscriptionPeriod.annual).perPeriod,
    ).toBe(2500 * 12);
  });

  test("pro annual → 12 × monthly", () => {
    expect(
      tierGrant(SubscriptionTier.pro, SubscriptionPeriod.annual).perPeriod,
    ).toBe(10000 * 12);
  });

  test("missing PAYMENTS_GRANT_BUILDER_MONTHLY throws 500", () => {
    delete process.env.PAYMENTS_GRANT_BUILDER_MONTHLY;
    expect(() =>
      tierGrant(SubscriptionTier.builder, SubscriptionPeriod.monthly),
    ).toThrow(/PAYMENTS_GRANT_BUILDER_MONTHLY/);
  });

  test("non-positive PAYMENTS_GRANT_PRO_MONTHLY throws", () => {
    process.env.PAYMENTS_GRANT_PRO_MONTHLY = "0";
    expect(() =>
      tierGrant(SubscriptionTier.pro, SubscriptionPeriod.monthly),
    ).toThrow(/positive integer/);
  });

  test("non-numeric throws", () => {
    process.env.PAYMENTS_GRANT_BUILDER_MONTHLY = "lots";
    expect(() =>
      tierGrant(SubscriptionTier.builder, SubscriptionPeriod.monthly),
    ).toThrow(/positive integer/);
  });
});
