import { describe, expect, test } from "vitest";
import { loadCatalogFromString } from "../../../scripts/sku/catalog";

const validYaml = `
subscriptionGroupReferenceName: convos_subscriptions
products:
  - tier: plus
    period: monthly
    productId: app.convos.subs.plus.monthly
    referenceName: Convos Plus Monthly
    localizations:
      en-US:
        name: Convos Plus
        description: Monthly Convos Plus subscription.
    pricing:
      USD: 999
    google:
      basePlanId: monthly
      billingPeriod: P1M
      autoRenewingPlan: true
`;

describe("loadCatalogFromString", () => {
  test("loads a valid catalog", () => {
    const c = loadCatalogFromString(validYaml);
    expect(c.subscriptionGroupReferenceName).toBe("convos_subscriptions");
    expect(c.products).toHaveLength(1);
    expect(c.products[0].productId).toBe("app.convos.subs.plus.monthly");
  });

  test("rejects when en-US localization missing", () => {
    const yaml = validYaml.replace("en-US:", "de-DE:");
    expect(() => loadCatalogFromString(yaml)).toThrow(/en-US/);
  });

  test("rejects when USD price missing", () => {
    const yaml = validYaml.replace("USD:", "EUR:");
    expect(() => loadCatalogFromString(yaml)).toThrow(/USD/);
  });

  test("rejects productId that doesn't match runtime pattern", () => {
    const yaml = validYaml.replace(
      "app.convos.subs.plus.monthly",
      "app.bogus.sku",
    );
    expect(() => loadCatalogFromString(yaml)).toThrow(/Unrecognized productId/);
  });

  test("rejects unknown tier value", () => {
    const yaml = validYaml.replace("tier: plus", "tier: pro");
    expect(() => loadCatalogFromString(yaml)).toThrow();
  });

  test("rejects when period disagrees with productId period", () => {
    const yaml = validYaml.replace("period: monthly", "period: annual");
    expect(() => loadCatalogFromString(yaml)).toThrow(
      /disagrees with productId period/,
    );
  });

  test("rejects bad billingPeriod format", () => {
    const yaml = validYaml.replace(
      "billingPeriod: P1M",
      "billingPeriod: 1 month",
    );
    expect(() => loadCatalogFromString(yaml)).toThrow(/billingPeriod/);
  });

  test("rejects duplicate productId", () => {
    const yaml = `
subscriptionGroupReferenceName: convos_subscriptions
products:
  - tier: plus
    period: monthly
    productId: app.convos.subs.plus.monthly
    referenceName: A
    localizations:
      en-US: { name: A, description: A }
    pricing: { USD: 999 }
    google: { basePlanId: monthly, billingPeriod: P1M, autoRenewingPlan: true }
  - tier: plus
    period: monthly
    productId: app.convos.subs.plus.monthly
    referenceName: B
    localizations:
      en-US: { name: B, description: B }
    pricing: { USD: 999 }
    google: { basePlanId: monthly, billingPeriod: P1M, autoRenewingPlan: true }
`;
    expect(() => loadCatalogFromString(yaml)).toThrow(/Duplicate productId/);
  });
});
