import { afterEach, beforeEach, describe, expect, test } from "vitest";

describe("PAYMENTS_GRANT_PLUS_MONTHLY (boot validation)", () => {
  const originalPlus = process.env.PAYMENTS_GRANT_PLUS_MONTHLY;
  const originalBuilder = process.env.PAYMENTS_GRANT_BUILDER_MONTHLY;

  beforeEach(() => {
    delete process.env.PAYMENTS_GRANT_BUILDER_MONTHLY;
  });

  afterEach(() => {
    if (originalPlus === undefined) {
      delete process.env.PAYMENTS_GRANT_PLUS_MONTHLY;
    } else {
      process.env.PAYMENTS_GRANT_PLUS_MONTHLY = originalPlus;
    }
    if (originalBuilder === undefined) {
      delete process.env.PAYMENTS_GRANT_BUILDER_MONTHLY;
    } else {
      process.env.PAYMENTS_GRANT_BUILDER_MONTHLY = originalBuilder;
    }
  });

  test("positive int → value", async () => {
    process.env.PAYMENTS_GRANT_PLUS_MONTHLY = "500000";
    const { loadGrantPlusMonthlyCredits } =
      await import("@/payments/credits/config");
    expect(loadGrantPlusMonthlyCredits()).toBe(500000);
  });

  test("unset (and no legacy fallback) throws — fails fast at boot", async () => {
    delete process.env.PAYMENTS_GRANT_PLUS_MONTHLY;
    const { loadGrantPlusMonthlyCredits } =
      await import("@/payments/credits/config");
    expect(() => loadGrantPlusMonthlyCredits()).toThrow(
      /PAYMENTS_GRANT_PLUS_MONTHLY/,
    );
  });

  test("empty string throws", async () => {
    process.env.PAYMENTS_GRANT_PLUS_MONTHLY = "";
    const { loadGrantPlusMonthlyCredits } =
      await import("@/payments/credits/config");
    expect(() => loadGrantPlusMonthlyCredits()).toThrow(
      /PAYMENTS_GRANT_PLUS_MONTHLY/,
    );
  });

  test("non-numeric throws", async () => {
    process.env.PAYMENTS_GRANT_PLUS_MONTHLY = "lots";
    const { loadGrantPlusMonthlyCredits } =
      await import("@/payments/credits/config");
    expect(() => loadGrantPlusMonthlyCredits()).toThrow(
      /must be a positive safe integer/,
    );
  });

  test("non-positive (0) throws", async () => {
    process.env.PAYMENTS_GRANT_PLUS_MONTHLY = "0";
    const { loadGrantPlusMonthlyCredits } =
      await import("@/payments/credits/config");
    expect(() => loadGrantPlusMonthlyCredits()).toThrow(
      /must be a positive safe integer/,
    );
  });

  test("negative throws", async () => {
    process.env.PAYMENTS_GRANT_PLUS_MONTHLY = "-5";
    const { loadGrantPlusMonthlyCredits } =
      await import("@/payments/credits/config");
    expect(() => loadGrantPlusMonthlyCredits()).toThrow(
      /must be a positive safe integer/,
    );
  });

  test("falls back to legacy PAYMENTS_GRANT_BUILDER_MONTHLY", async () => {
    delete process.env.PAYMENTS_GRANT_PLUS_MONTHLY;
    process.env.PAYMENTS_GRANT_BUILDER_MONTHLY = "4321";
    const { loadGrantPlusMonthlyCredits } =
      await import("@/payments/credits/config");
    expect(loadGrantPlusMonthlyCredits()).toBe(4321);
  });

  test("loadConfig surfaces grantPlusMonthlyCredits", async () => {
    process.env.PAYMENTS_GRANT_PLUS_MONTHLY = "500000";
    const { loadConfig } = await import("@/payments/credits/config");
    expect(loadConfig().grantPlusMonthlyCredits).toBe(500000);
  });

  // N-N2: the boot validator must not be STRICTER than the prior lazy
  // tier-config `Number.parseInt(raw, 10)` path. Any value that booted the
  // running system before (surrounding whitespace, parseInt-tolerated trailing
  // forms) must still boot here — the validator only moves the same
  // unset/non-numeric/non-positive failure earlier, never adds new rejects.
  describe("N-N2: parses leniently (no boot regression vs legacy parseInt)", () => {
    test("surrounding whitespace still boots", async () => {
      process.env.PAYMENTS_GRANT_PLUS_MONTHLY = "  500000\n";
      const { loadGrantPlusMonthlyCredits } =
        await import("@/payments/credits/config");
      expect(loadGrantPlusMonthlyCredits()).toBe(500000);
    });

    test('"500000.0" still boots (parseInt truncates, as before)', async () => {
      process.env.PAYMENTS_GRANT_PLUS_MONTHLY = "500000.0";
      const { loadGrantPlusMonthlyCredits } =
        await import("@/payments/credits/config");
      expect(loadGrantPlusMonthlyCredits()).toBe(500000);
    });
  });
});
