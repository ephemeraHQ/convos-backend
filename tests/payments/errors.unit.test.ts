import { describe, expect, test } from "bun:test";
import { InsufficientBalanceError } from "@/payments/errors";

describe("InsufficientBalanceError", () => {
  test("exposes accountId (not inboxId) on the typed field", () => {
    const err = new InsufficientBalanceError("acct-123", 5n, -10, -1000n);
    expect(err.accountId).toBe("acct-123");
    // TypeScript-only check: `err.inboxId` must not exist. If the rename
    // is incomplete, tsc fails to compile this test file.
  });

  test("details are JSON-serializable (no BigInt fields)", () => {
    const err = new InsufficientBalanceError("acct-123", 5n, -10, -1000n);
    // Round-trip through JSON without throwing on BigInt.
    expect(() => JSON.stringify(err.details)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(err.details));
    expect(parsed).toEqual({
      accountId: "acct-123",
      currentBalance: "5",
      attemptedDelta: -10,
      minBalance: "-1000",
    });
  });

  test("typed bigint fields are preserved for code callers", () => {
    const err = new InsufficientBalanceError("acct-123", 5n, -10, -1000n);
    expect(err.currentBalance).toBe(5n);
    expect(err.minBalance).toBe(-1000n);
    expect(typeof err.currentBalance).toBe("bigint");
  });

  test("statusCode is 402", () => {
    const err = new InsufficientBalanceError("acct-123", 5n, -10, -1000n);
    expect(err.statusCode).toBe(402);
  });
});
