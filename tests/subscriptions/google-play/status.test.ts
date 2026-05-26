import { SubscriptionStatus } from "@prisma/client";
import { describe, expect, test } from "vitest";
import type { SubscriptionPurchaseV2 } from "@/subscriptions/google-play/play-api";
import {
  deriveStatusFromPurchase,
  extractObfuscatedAccountId,
  extractPeriodWindow,
  extractProductId,
  PlaySubscriptionState,
} from "@/subscriptions/google-play/status";

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
      offerDetails: { offerTags: [] },
    },
  ],
  externalAccountIdentifiers: {
    obfuscatedExternalAccountId: "obf-1234",
  },
  ...overrides,
});

describe("deriveStatusFromPurchase", () => {
  test("ACTIVE → active", () => {
    expect(deriveStatusFromPurchase(purchase({}))).toBe(
      SubscriptionStatus.active,
    );
  });

  test("ACTIVE with free_trial offer tag → trial", () => {
    expect(
      deriveStatusFromPurchase(
        purchase({
          lineItems: [
            {
              productId: "app.convos.subs.builder.monthly",
              expiryTime: "2026-06-01T00:00:00.000Z",
              offerDetails: { offerTags: ["free_trial"] },
            },
          ],
        }),
      ),
    ).toBe(SubscriptionStatus.trial);
  });

  test("IN_GRACE_PERIOD → grace", () => {
    expect(
      deriveStatusFromPurchase(
        purchase({ subscriptionState: PlaySubscriptionState.inGracePeriod }),
      ),
    ).toBe(SubscriptionStatus.grace);
  });

  test("ON_HOLD and PAUSED → billingRetry", () => {
    expect(
      deriveStatusFromPurchase(
        purchase({ subscriptionState: PlaySubscriptionState.onHold }),
      ),
    ).toBe(SubscriptionStatus.billingRetry);
    expect(
      deriveStatusFromPurchase(
        purchase({ subscriptionState: PlaySubscriptionState.paused }),
      ),
    ).toBe(SubscriptionStatus.billingRetry);
  });

  test("EXPIRED → expired", () => {
    expect(
      deriveStatusFromPurchase(
        purchase({ subscriptionState: PlaySubscriptionState.expired }),
      ),
    ).toBe(SubscriptionStatus.expired);
  });

  test("CANCELED + expiryTime in future → active (entitled until expiry)", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      deriveStatusFromPurchase(
        purchase({
          subscriptionState: PlaySubscriptionState.cancelled,
          lineItems: [
            {
              productId: "app.convos.subs.builder.monthly",
              expiryTime: future,
            },
          ],
        }),
      ),
    ).toBe(SubscriptionStatus.active);
  });

  test("CANCELED + expiryTime in past → expired", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(
      deriveStatusFromPurchase(
        purchase({
          subscriptionState: PlaySubscriptionState.cancelled,
          lineItems: [
            {
              productId: "app.convos.subs.builder.monthly",
              expiryTime: past,
            },
          ],
        }),
      ),
    ).toBe(SubscriptionStatus.expired);
  });

  test("PENDING throws", () => {
    expect(() =>
      deriveStatusFromPurchase(
        purchase({ subscriptionState: PlaySubscriptionState.pending }),
      ),
    ).toThrow(/pending/i);
  });
});

describe("extractPeriodWindow", () => {
  test("returns startTime and expiryTime as Dates", () => {
    const w = extractPeriodWindow(purchase({}));
    expect(w.currentPeriodStart.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(w.currentPeriodEnd.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  test("throws when lineItem missing expiryTime", () => {
    expect(() =>
      extractPeriodWindow(
        purchase({
          lineItems: [{ productId: "app.convos.subs.builder.monthly" }],
        }),
      ),
    ).toThrow(/expiryTime/);
  });
});

describe("extractProductId", () => {
  test("returns first line item productId", () => {
    expect(extractProductId(purchase({}))).toBe(
      "app.convos.subs.builder.monthly",
    );
  });
});

describe("extractObfuscatedAccountId", () => {
  test("returns the obfuscatedExternalAccountId when set", () => {
    expect(extractObfuscatedAccountId(purchase({}))).toBe("obf-1234");
  });

  test("returns null when missing", () => {
    expect(
      extractObfuscatedAccountId(
        purchase({ externalAccountIdentifiers: undefined }),
      ),
    ).toBeNull();
  });
});
