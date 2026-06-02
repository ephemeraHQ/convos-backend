import { afterEach, describe, expect, test } from "vitest";

describe("PAYMENTS_SIGNUP_BONUS_CREDITS", () => {
  const original = process.env.PAYMENTS_SIGNUP_BONUS_CREDITS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.PAYMENTS_SIGNUP_BONUS_CREDITS;
    } else {
      process.env.PAYMENTS_SIGNUP_BONUS_CREDITS = original;
    }
  });

  test("unset → 0 (disabled)", async () => {
    delete process.env.PAYMENTS_SIGNUP_BONUS_CREDITS;
    const { loadSignupBonusCredits } = await import("@/payments/credits/config");
    expect(loadSignupBonusCredits()).toBe(0);
  });

  test("empty string → 0 (disabled)", async () => {
    process.env.PAYMENTS_SIGNUP_BONUS_CREDITS = "";
    const { loadSignupBonusCredits } = await import("@/payments/credits/config");
    expect(loadSignupBonusCredits()).toBe(0);
  });

  test('"0" → 0 (disabled)', async () => {
    process.env.PAYMENTS_SIGNUP_BONUS_CREDITS = "0";
    const { loadSignupBonusCredits } = await import("@/payments/credits/config");
    expect(loadSignupBonusCredits()).toBe(0);
  });

  test("positive int → value", async () => {
    process.env.PAYMENTS_SIGNUP_BONUS_CREDITS = "5000";
    const { loadSignupBonusCredits } = await import("@/payments/credits/config");
    expect(loadSignupBonusCredits()).toBe(5000);
  });

  test("rejects negative", async () => {
    process.env.PAYMENTS_SIGNUP_BONUS_CREDITS = "-1";
    const { loadSignupBonusCredits } = await import("@/payments/credits/config");
    expect(() => loadSignupBonusCredits()).toThrow(
      /must be a non-negative safe integer/,
    );
  });

  test("rejects non-integer", async () => {
    process.env.PAYMENTS_SIGNUP_BONUS_CREDITS = "1.5";
    const { loadSignupBonusCredits } = await import("@/payments/credits/config");
    expect(() => loadSignupBonusCredits()).toThrow(
      /must be a non-negative safe integer/,
    );
  });

  test("rejects alpha", async () => {
    process.env.PAYMENTS_SIGNUP_BONUS_CREDITS = "abc";
    const { loadSignupBonusCredits } = await import("@/payments/credits/config");
    expect(() => loadSignupBonusCredits()).toThrow(
      /must be a non-negative safe integer/,
    );
  });
});
