import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  assertIdempotencyKey,
  IDEMPOTENCY_KEY_REGEX,
  idempotencyKeySchema,
} from "@/payments/ledger/idempotency-key";
import { subForfeitKey, subGrantKey } from "@/subscriptions/grants";

// Guard (#1): the conceptual `sub_grant:{id}:{epoch}` form uses colons, which the
// Stripe-style idempotency charset ([A-Za-z0-9_-]) forbids. The builders render
// it with underscores instead, and `applyDeltaWithTx` runs `assertIdempotencyKey`
// on every write — so a builder that ever emitted a colon (or any disallowed
// char) would throw at runtime on the grant/forfeit path. Pin the contract here
// so a future edit to the key format fails this unit test, not production.

const SUBSCRIPTION_IDS = [
  randomUUID(),
  "61ceb68c-465b-4b1b-8da4-cefc74bc21cf",
  "00000000-0000-0000-0000-000000000000",
];

const PERIOD_STARTS = [
  new Date("2026-06-30T00:00:00.000Z"),
  new Date(0), // epoch 0
  new Date("2026-12-31T23:59:59.999Z"), // fractional second → floored epoch
];

describe("subscription grant/forfeit idempotency keys pass the schema", () => {
  for (const subscriptionId of SUBSCRIPTION_IDS) {
    for (const periodStart of PERIOD_STARTS) {
      const grantKey = subGrantKey(subscriptionId, periodStart);
      const forfeitKey = subForfeitKey(subscriptionId, periodStart);

      test(`subGrantKey(${subscriptionId}, ${periodStart.toISOString()}) is valid`, () => {
        expect(grantKey).toMatch(IDEMPOTENCY_KEY_REGEX);
        expect(idempotencyKeySchema.safeParse(grantKey).success).toBe(true);
        expect(() => {
          assertIdempotencyKey(grantKey);
        }).not.toThrow();
        expect(grantKey).not.toContain(":");
      });

      test(`subForfeitKey(${subscriptionId}, ${periodStart.toISOString()}) is valid`, () => {
        expect(forfeitKey).toMatch(IDEMPOTENCY_KEY_REGEX);
        expect(idempotencyKeySchema.safeParse(forfeitKey).success).toBe(true);
        expect(() => {
          assertIdempotencyKey(forfeitKey);
        }).not.toThrow();
        expect(forfeitKey).not.toContain(":");
      });
    }
  }

  test("grant and forfeit keys for the same (sub, period) are distinct", () => {
    const id = randomUUID();
    const start = new Date("2026-06-30T00:00:00.000Z");
    expect(subGrantKey(id, start)).not.toBe(subForfeitKey(id, start));
  });
});
