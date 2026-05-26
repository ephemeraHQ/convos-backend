import { describe, expect, test } from "vitest";
import * as appleClient from "../../../scripts/sku/apple-connect";
import * as googleClient from "../../../scripts/sku/google-play-catalog";
import type {
  DesiredProduct,
  RemoteGoogleProduct,
} from "../../../scripts/sku/types";

const desired: DesiredProduct = {
  tier: "plus",
  period: "monthly",
  productId: "app.convos.subs.plus.monthly",
  referenceName: "Convos Plus Monthly",
  localizations: {
    "en-US": {
      name: "Convos Plus",
      description: "Monthly subscription to Convos Plus.",
    },
  },
  pricing: { USD: 999, EUR: 999 },
  google: {
    basePlanId: "monthly",
    billingPeriod: "P1M",
    autoRenewingPlan: true,
  },
};

describe("google computeDiff", () => {
  test("missing remote → create op for sub + base plan + each price", () => {
    const diff = googleClient.computeDiff(desired, null);
    expect(diff.store).toBe("google");
    const creates = diff.ops.filter((o) => o.kind === "create");
    expect(creates.length).toBeGreaterThanOrEqual(4); // subscription, en-US, basePlan, +1 price (USD or EUR)
    expect(creates.some((o) => o.field === "subscription")).toBe(true);
    expect(creates.some((o) => o.field === "basePlan")).toBe(true);
  });

  test("matching remote → no ops", () => {
    const remote: RemoteGoogleProduct = {
      productId: desired.productId,
      localizations: desired.localizations,
      basePlan: {
        basePlanId: "monthly",
        billingPeriod: "P1M",
        autoRenewingPlan: true,
        state: "ACTIVE",
        regionalPrices: { USD: 999, EUR: 999 },
      },
    };
    const diff = googleClient.computeDiff(desired, remote);
    expect(diff.ops).toEqual([]);
  });

  test("single price change → single update op", () => {
    const remote: RemoteGoogleProduct = {
      productId: desired.productId,
      localizations: desired.localizations,
      basePlan: {
        basePlanId: "monthly",
        billingPeriod: "P1M",
        autoRenewingPlan: true,
        state: "ACTIVE",
        regionalPrices: { USD: 899, EUR: 999 },
      },
    };
    const diff = googleClient.computeDiff(desired, remote);
    expect(diff.ops).toEqual([
      {
        kind: "update",
        field: "basePlan.regionalPrices.USD",
        from: 899,
        to: 999,
      },
    ]);
  });

  test("localization name update produces a single op", () => {
    const remote: RemoteGoogleProduct = {
      productId: desired.productId,
      localizations: {
        "en-US": {
          name: "Convos Plus OLD",
          description: "Monthly subscription to Convos Plus.",
        },
      },
      basePlan: {
        basePlanId: "monthly",
        billingPeriod: "P1M",
        autoRenewingPlan: true,
        state: "ACTIVE",
        regionalPrices: { USD: 999, EUR: 999 },
      },
    };
    const diff = googleClient.computeDiff(desired, remote);
    expect(diff.ops).toEqual([
      {
        kind: "update",
        field: "localizations.en-US.name",
        from: "Convos Plus OLD",
        to: "Convos Plus",
      },
    ]);
  });
});

describe("apple computeDiff", () => {
  test("missing remote → isAppleCreate true + create op", () => {
    const diff = appleClient.computeDiff(desired, null);
    expect(diff.store).toBe("apple");
    expect(diff.isAppleCreate).toBe(true);
    expect(
      diff.ops.some((o) => o.kind === "create" && o.field === "subscription"),
    ).toBe(true);
  });

  test("matching remote → no ops", () => {
    const diff = appleClient.computeDiff(desired, {
      id: "sub-1",
      productId: desired.productId,
      referenceName: desired.referenceName,
      state: "APPROVED",
      subscriptionPeriod: "ONE_MONTH",
      localizations: {
        "en-US": {
          id: "loc-1",
          name: "Convos Plus",
          description: "Monthly subscription to Convos Plus.",
        },
      },
      prices: {
        USD: { pricePointId: "pp-usd-999", minorUnits: 999 },
        EUR: { pricePointId: "pp-eur-999", minorUnits: 999 },
      },
    });
    expect(diff.ops).toEqual([]);
  });

  test("flags immutable period mismatch", () => {
    const diff = appleClient.computeDiff(desired, {
      id: "sub-1",
      productId: desired.productId,
      referenceName: desired.referenceName,
      state: "APPROVED",
      subscriptionPeriod: "ONE_YEAR", // wrong
      localizations: {
        "en-US": {
          id: "loc-1",
          name: "Convos Plus",
          description: "Monthly subscription to Convos Plus.",
        },
      },
      prices: {
        USD: { pricePointId: "pp-usd-999", minorUnits: 999 },
        EUR: { pricePointId: "pp-eur-999", minorUnits: 999 },
      },
    });
    expect(
      diff.ops.some((o) => o.field === "subscriptionPeriod[!immutable]"),
    ).toBe(true);
  });
});
