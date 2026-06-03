import { describe, expect, test } from "vitest";
import {
  assertIdempotencyKey,
  idempotencyKeySchema,
} from "@/payments/ledger/idempotency-key";
import { ValidationError } from "@/utils/errors";

const VALID = [
  "a_b-C9",
  "61ceb68c-465b-4b1b-8da4-cefc74bc21cf",
  "signup_bonus_61ceb68c-465b-4b1b-8da4-cefc74bc21cf",
  "daily_refill_61ceb68c-465b-4b1b-8da4-cefc74bc21cf_2024-01-15",
  "a".repeat(255),
];

const INVALID = [
  "daily_refill:acct:2026-06-03",
  "has space",
  "key.dot",
  "key/slash",
  "",
  "a".repeat(256),
];

describe("idempotency key charset", () => {
  test.each(VALID)("accepts %s", (key) => {
    expect(() => {
      assertIdempotencyKey(key);
    }).not.toThrow();
    expect(idempotencyKeySchema.safeParse(key).success).toBe(true);
  });

  test.each(INVALID)("rejects %s", (key) => {
    expect(() => {
      assertIdempotencyKey(key);
    }).toThrow(ValidationError);
    expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});
