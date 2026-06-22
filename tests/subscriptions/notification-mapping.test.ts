import {
  NotificationTypeV2,
  Subtype,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import { SubscriptionStatus } from "@prisma/client";
import { describe, expect, test } from "vitest";
import { mapNotificationToUpdate } from "@/subscriptions/notification-mapping";

const PLUS_MONTHLY = "app.convos.subs.plus.monthly";
const EXPIRES_MS = new Date("2026-05-01T00:00:00.000Z").getTime();

const transaction = (
  overrides: Partial<JWSTransactionDecodedPayload> = {},
): JWSTransactionDecodedPayload => ({
  productId: PLUS_MONTHLY,
  purchaseDate: new Date("2026-04-01T00:00:00.000Z").getTime(),
  expiresDate: EXPIRES_MS,
  signedDate: new Date("2026-05-01T12:00:00.000Z").getTime(),
  ...overrides,
});

describe("mapNotificationToUpdate — grace deadline via gracePeriodEnd", () => {
  test("DID_FAIL_TO_RENEW + GRACE_PERIOD → grace status with gracePeriodEnd set from expiresDate", () => {
    const update = mapNotificationToUpdate({
      notificationType: NotificationTypeV2.DID_FAIL_TO_RENEW,
      subtype: Subtype.GRACE_PERIOD,
      transaction: transaction(),
    });
    expect(update?.status).toBe(SubscriptionStatus.grace);
    // The grace deadline lives in the single gracePeriodEnd field — no separate
    // billingRetryEndsAt column exists.
    expect(update?.gracePeriodEnd?.getTime()).toBe(EXPIRES_MS);
  });

  test("DID_FAIL_TO_RENEW (billing retry, no subtype) → billingRetry and clears gracePeriodEnd (status=3 is NOT a grace window)", () => {
    const update = mapNotificationToUpdate({
      notificationType: NotificationTypeV2.DID_FAIL_TO_RENEW,
      subtype: null,
      transaction: transaction(),
    });
    expect(update?.status).toBe(SubscriptionStatus.billingRetry);
    // B-N2: explicitly cleared so a stale future grace deadline can't keep the
    // row entitled past the provider cutoff. status.ts then governs it by
    // currentPeriodEnd only.
    expect(update?.gracePeriodEnd).toBeNull();
  });

  test("DID_FAIL_TO_RENEW + BILLING_RETRY subtype → billingRetry and clears gracePeriodEnd", () => {
    const update = mapNotificationToUpdate({
      notificationType: NotificationTypeV2.DID_FAIL_TO_RENEW,
      subtype: Subtype.BILLING_RETRY,
      transaction: transaction(),
    });
    expect(update?.status).toBe(SubscriptionStatus.billingRetry);
    expect(update?.gracePeriodEnd).toBeNull();
  });

  test("DID_RENEW clears gracePeriodEnd", () => {
    // A successful renewal carries a future expiry — deriveSubscriptionStatus-
    // FromTransaction reads the real clock, so use a date ahead of `now`.
    const futureExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const update = mapNotificationToUpdate({
      notificationType: NotificationTypeV2.DID_RENEW,
      subtype: null,
      transaction: transaction({ expiresDate: futureExpiry }),
    });
    expect(update?.status).toBe(SubscriptionStatus.active);
    expect(update?.gracePeriodEnd).toBeNull();
  });

  test("SUBSCRIBED clears gracePeriodEnd", () => {
    const futureExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const update = mapNotificationToUpdate({
      notificationType: NotificationTypeV2.SUBSCRIBED,
      subtype: null,
      transaction: transaction({ expiresDate: futureExpiry }),
    });
    expect(update?.gracePeriodEnd).toBeNull();
  });

  test("EXPIRED clears gracePeriodEnd", () => {
    const update = mapNotificationToUpdate({
      notificationType: NotificationTypeV2.EXPIRED,
      subtype: null,
      transaction: transaction(),
    });
    expect(update?.status).toBe(SubscriptionStatus.expired);
    expect(update?.gracePeriodEnd).toBeNull();
  });

  test("GRACE_PERIOD_EXPIRED clears gracePeriodEnd", () => {
    const update = mapNotificationToUpdate({
      notificationType: NotificationTypeV2.GRACE_PERIOD_EXPIRED,
      subtype: null,
      transaction: transaction(),
    });
    expect(update?.status).toBe(SubscriptionStatus.expired);
    expect(update?.gracePeriodEnd).toBeNull();
  });

  test("REVOKE clears gracePeriodEnd", () => {
    const update = mapNotificationToUpdate({
      notificationType: NotificationTypeV2.REVOKE,
      subtype: null,
      transaction: transaction(),
    });
    expect(update?.status).toBe(SubscriptionStatus.revoked);
    expect(update?.gracePeriodEnd).toBeNull();
  });

  test("REFUND clears gracePeriodEnd", () => {
    const update = mapNotificationToUpdate({
      notificationType: NotificationTypeV2.REFUND,
      subtype: null,
      transaction: transaction(),
    });
    expect(update?.status).toBe(SubscriptionStatus.revoked);
    expect(update?.gracePeriodEnd).toBeNull();
  });

  test("no billingRetryEndsAt key is ever produced by the mapping", () => {
    const update = mapNotificationToUpdate({
      notificationType: NotificationTypeV2.DID_FAIL_TO_RENEW,
      subtype: Subtype.GRACE_PERIOD,
      transaction: transaction(),
    });
    expect(update).not.toHaveProperty("billingRetryEndsAt");
  });
});
