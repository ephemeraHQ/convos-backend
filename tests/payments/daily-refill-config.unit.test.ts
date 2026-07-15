import { afterEach, describe, expect, test } from "vitest";

describe("PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS", () => {
  const original = process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS;
    } else {
      process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = original;
    }
  });

  test("loads positive int (refill enabled, behavior unchanged)", async () => {
    process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = "100";
    const { loadFreeTierDailyCapCredits } =
      await import("@/payments/credits/config");
    expect(loadFreeTierDailyCapCredits()).toBe(100);
  });

  // Kill-switch contract (mirrors PAYMENTS_SIGNUP_BONUS_CREDITS): unset,
  // empty, or "0" all mean "daily refill disabled" — the OFF state must be
  // expressible in config so credits-get stops advertising a refresh that
  // will not come. Do NOT re-tighten these to throw.
  test("missing → 0 (refill disabled)", async () => {
    delete process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS;
    const { loadFreeTierDailyCapCredits } =
      await import("@/payments/credits/config");
    expect(loadFreeTierDailyCapCredits()).toBe(0);
  });

  test("empty string → 0 (refill disabled)", async () => {
    process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = "";
    const { loadFreeTierDailyCapCredits } =
      await import("@/payments/credits/config");
    expect(loadFreeTierDailyCapCredits()).toBe(0);
  });

  test("zero → 0 (refill disabled)", async () => {
    process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = "0";
    const { loadFreeTierDailyCapCredits } =
      await import("@/payments/credits/config");
    expect(loadFreeTierDailyCapCredits()).toBe(0);
  });

  test("rejects negative", async () => {
    process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = "-5";
    const { loadFreeTierDailyCapCredits } =
      await import("@/payments/credits/config");
    expect(() => loadFreeTierDailyCapCredits()).toThrow(
      /must be a non-negative safe integer/,
    );
  });

  test("rejects non-integer", async () => {
    process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = "1.5";
    const { loadFreeTierDailyCapCredits } =
      await import("@/payments/credits/config");
    expect(() => loadFreeTierDailyCapCredits()).toThrow(
      /must be a non-negative safe integer/,
    );
  });

  test("rejects alpha string", async () => {
    process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = "abc";
    const { loadFreeTierDailyCapCredits } =
      await import("@/payments/credits/config");
    expect(() => loadFreeTierDailyCapCredits()).toThrow(
      /must be a non-negative safe integer/,
    );
  });

  test("rejects unsafe magnitude", async () => {
    process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = "9007199254740993";
    const { loadFreeTierDailyCapCredits } =
      await import("@/payments/credits/config");
    expect(() => loadFreeTierDailyCapCredits()).toThrow(
      /must be a non-negative safe integer/,
    );
  });
});
