import { afterEach, describe, expect, test } from "bun:test";

describe("PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS", () => {
  const original = process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS;
    } else {
      process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = original;
    }
  });

  test("loads positive int", async () => {
    process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = "100";
    const { loadFreeTierDailyCapCredits } = await import(
      "@/payments/credits/config"
    );
    expect(loadFreeTierDailyCapCredits()).toBe(100);
  });

  test("rejects missing", async () => {
    delete process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS;
    const { loadFreeTierDailyCapCredits } = await import(
      "@/payments/credits/config"
    );
    expect(() => loadFreeTierDailyCapCredits()).toThrow(/not configured/);
  });

  test("rejects zero", async () => {
    process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = "0";
    const { loadFreeTierDailyCapCredits } = await import(
      "@/payments/credits/config"
    );
    expect(() => loadFreeTierDailyCapCredits()).toThrow(/must be > 0/);
  });

  test("rejects negative", async () => {
    process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = "-5";
    const { loadFreeTierDailyCapCredits } = await import(
      "@/payments/credits/config"
    );
    expect(() => loadFreeTierDailyCapCredits()).toThrow(/must be > 0/);
  });

  test("rejects non-integer", async () => {
    process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS = "1.5";
    const { loadFreeTierDailyCapCredits } = await import(
      "@/payments/credits/config"
    );
    expect(() => loadFreeTierDailyCapCredits()).toThrow(/must be an integer/);
  });
});
