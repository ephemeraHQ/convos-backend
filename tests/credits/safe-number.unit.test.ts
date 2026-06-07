import { describe, expect, it } from "vitest";
import { bigintToSafeNumber } from "@/payments/credits/safe-number";
import { ValidationError } from "@/utils/errors";

describe("bigintToSafeNumber", () => {
  it("converts values within the safe-integer range", () => {
    expect(bigintToSafeNumber(0n, "x")).toBe(0);
    expect(bigintToSafeNumber(150n, "x")).toBe(150);
    expect(bigintToSafeNumber(-150n, "x")).toBe(-150);
    expect(bigintToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER), "x")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("throws a ValidationError above the safe-integer range", () => {
    expect(() =>
      bigintToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "consumed"),
    ).toThrow(ValidationError);
  });

  it("throws a ValidationError below the negative safe-integer range", () => {
    expect(() =>
      bigintToSafeNumber(-(BigInt(Number.MAX_SAFE_INTEGER) + 1n), "consumed"),
    ).toThrow(ValidationError);
  });
});
