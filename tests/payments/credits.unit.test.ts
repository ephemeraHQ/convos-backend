import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isAllowedFromBalance } from "@/payments/credits/policy";
import { creditsToUsd, usdToCredits } from "@/payments/credits/pricing";

const ENV_KEYS = [
  "PAYMENTS_MARKUP_RATE",
  "PAYMENTS_CREDITS_PER_USD",
  "PAYMENTS_RESERVED_MAX_TURN_CREDITS",
  "PAYMENTS_MIN_BALANCE_CREDITS",
] as const;

const snapshot = (): Record<string, string | undefined> =>
  Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const restore = (snap: Record<string, string | undefined>) => {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = snap[k];
  }
};

describe("payments/credits/config", () => {
  let snap: Record<string, string | undefined> = {};

  beforeEach(() => {
    snap = snapshot();
  });

  afterEach(() => {
    restore(snap);
  });

  test("loads valid env into typed config", async () => {
    process.env.PAYMENTS_MARKUP_RATE = "2.0";
    process.env.PAYMENTS_CREDITS_PER_USD = "1000";
    process.env.PAYMENTS_RESERVED_MAX_TURN_CREDITS = "1";
    process.env.PAYMENTS_MIN_BALANCE_CREDITS = "-1000";

    const { loadConfig } = await import("@/payments/credits/config");
    const cfg = loadConfig();

    expect(cfg.markupRateBps).toBe(20000n);
    expect(cfg.markupRate).toBe("2");
    expect(cfg.creditsPerDollar).toBe(1000n);
    expect(cfg.reservedMaxTurnCredits).toBe(1n);
    expect(cfg.minBalance).toBe(-1000n);
  });

  // The dynamic `import("@/payments/credits/config")` returns the same cached
  // module across tests; that's intentional. These tests work because they
  // call `loadConfig()` directly, which re-reads `process.env` on every call —
  // NOT the cached `config` singleton (which snapshots env at first import).
  test("rejects negative markup", async () => {
    process.env.PAYMENTS_MARKUP_RATE = "-1";
    const { loadConfig } = await import("@/payments/credits/config");
    expect(() => loadConfig()).toThrow(/PAYMENTS_MARKUP_RATE must be >= 0/);
  });

  test("rejects zero creditsPerDollar", async () => {
    process.env.PAYMENTS_CREDITS_PER_USD = "0";
    const { loadConfig } = await import("@/payments/credits/config");
    expect(() => loadConfig()).toThrow(/PAYMENTS_CREDITS_PER_USD must be > 0/);
  });

  test("rejects positive minBalance", async () => {
    process.env.PAYMENTS_MIN_BALANCE_CREDITS = "10";
    const { loadConfig } = await import("@/payments/credits/config");
    expect(() => loadConfig()).toThrow(
      /PAYMENTS_MIN_BALANCE_CREDITS must be <= 0/,
    );
  });

  test("rejects non-numeric markup", async () => {
    process.env.PAYMENTS_MARKUP_RATE = "abc";
    const { loadConfig } = await import("@/payments/credits/config");
    expect(() => loadConfig()).toThrow();
  });
});

describe("payments/credits/pricing", () => {
  test("zero usd → zero credits", () => {
    expect(usdToCredits(0n)).toBe(0);
  });

  test("worked example from spec: $0.002 → 4 credits", () => {
    expect(usdToCredits(2000n)).toBe(4);
  });

  test("ceil rounds up sub-credit micro values", () => {
    expect(usdToCredits(1n)).toBe(1);
  });

  test("large values stay exact (no float drift)", () => {
    expect(usdToCredits(1_000_000_000n)).toBe(2_000_000);
  });

  test("creditsToUsd(usdToCredits(x)) >= x and within one credit's worth of micros", () => {
    const inputs = [0n, 1n, 999n, 2000n, 1_500_000n];
    for (const x of inputs) {
      const credits = usdToCredits(x);
      const back = creditsToUsd(credits);
      expect(back).toBeGreaterThanOrEqual(x);
      expect(back - x).toBeLessThanOrEqual(500n);
    }
  });

  test("creditsToUsd rejects non-integer credits", () => {
    expect(() => creditsToUsd(1.5)).toThrow(/must be an integer/);
  });

  test("creditsToUsd rejects unsafe integer", () => {
    expect(() => creditsToUsd(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /exceeds safe integer/,
    );
  });

  test("usdToCredits result within safe integer range", () => {
    // With default config (markup=2, cpd=1000), even large USD values
    // stay within safe range. This test documents the guard exists.
    const result = usdToCredits(1_000_000_000_000n);
    expect(Number.isSafeInteger(result)).toBe(true);
  });
});

describe("payments/credits/policy", () => {
  test("balance equal to threshold → allowed", () => {
    expect(isAllowedFromBalance(1n)).toBe(true);
  });

  test("balance above threshold → allowed", () => {
    expect(isAllowedFromBalance(100n)).toBe(true);
  });

  test("balance below threshold → not allowed", () => {
    expect(isAllowedFromBalance(0n)).toBe(false);
  });

  test("negative balance → not allowed", () => {
    expect(isAllowedFromBalance(-5n)).toBe(false);
  });
});
