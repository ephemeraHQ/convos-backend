import { SubscriptionPeriod } from "@prisma/client";
import { describe, expect, test } from "vitest";
import { productMapping } from "@/subscriptions/product-mapping";
import { SUBSCRIPTION_TIER_PLUS } from "@/subscriptions/tiers";

describe("productMapping", () => {
  test("maps current prod SKUs (plus.<period>) to plus", () => {
    expect(productMapping("app.convos.subs.plus.monthly")).toEqual({
      tier: SUBSCRIPTION_TIER_PLUS,
      period: SubscriptionPeriod.monthly,
    });
    expect(productMapping("app.convos.subs.plus.annual")).toEqual({
      tier: SUBSCRIPTION_TIER_PLUS,
      period: SubscriptionPeriod.annual,
    });
  });

  test("maps unprefixed dev SKUs (<period>) to plus", () => {
    expect(productMapping("app.convos.subs.monthly").period).toBe(
      SubscriptionPeriod.monthly,
    );
    expect(productMapping("app.convos.subs.annual").period).toBe(
      SubscriptionPeriod.annual,
    );
  });

  // Apple keeps returning the original productId on renewals/upgrades for the
  // life of a subscription, so legacy builder/pro subs must still verify. All
  // tiers collapsed to plus in #263 — see CON-386.
  test("maps legacy builder/pro SKUs to plus", () => {
    expect(productMapping("app.convos.subs.builder.monthly")).toEqual({
      tier: SUBSCRIPTION_TIER_PLUS,
      period: SubscriptionPeriod.monthly,
    });
    expect(productMapping("app.convos.subs.builder.annual").tier).toBe(
      SUBSCRIPTION_TIER_PLUS,
    );
    expect(productMapping("app.convos.subs.pro.monthly").tier).toBe(
      SUBSCRIPTION_TIER_PLUS,
    );
    expect(productMapping("app.convos.subs.pro.annual")).toEqual({
      tier: SUBSCRIPTION_TIER_PLUS,
      period: SubscriptionPeriod.annual,
    });
  });

  test("rejects unknown tier prefixes, wrong periods, and trailing junk", () => {
    for (const bad of [
      "app.convos.subs.enterprise.monthly", // unknown tier
      "app.convos.subs.plus.weekly", // unknown period
      "app.convos.subs.monthly.extra", // trailing junk
      "app.convos.subs.builder", // missing period
      "com.someone.else.monthly", // foreign namespace
      "", // empty
    ]) {
      expect(() => productMapping(bad)).toThrow(/Unrecognized productId/);
    }
  });
});
