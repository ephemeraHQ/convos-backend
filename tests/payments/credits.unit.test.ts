import { afterEach, describe, expect, test } from "bun:test";

const ENV_KEYS = [
  "PAYMENTS_MARKUP_RATE",
  "PAYMENTS_CREDITS_PER_DOLLAR",
  "PAYMENTS_RESERVED_MAX_TURN_CREDITS",
  "PAYMENTS_MIN_BALANCE",
] as const;

const snapshot = (): Record<string, string | undefined> =>
  Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const restore = (snap: Record<string, string | undefined>) => {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
};

describe("payments/credits/config", () => {
  let snap: Record<string, string | undefined>;

  afterEach(() => {
    if (snap) restore(snap);
  });

  test("loads valid env into typed config", async () => {
    snap = snapshot();
    process.env.PAYMENTS_MARKUP_RATE = "2.0";
    process.env.PAYMENTS_CREDITS_PER_DOLLAR = "1000";
    process.env.PAYMENTS_RESERVED_MAX_TURN_CREDITS = "1";
    process.env.PAYMENTS_MIN_BALANCE = "-1000";

    const { loadConfig } = await import("@/payments/credits/config");
    const cfg = loadConfig();

    expect(cfg.markupRateBps).toBe(20000n);
    expect(cfg.creditsPerDollar).toBe(1000n);
    expect(cfg.reservedMaxTurnCredits).toBe(1n);
    expect(cfg.minBalance).toBe(-1000n);
  });

  test("rejects negative markup", async () => {
    snap = snapshot();
    process.env.PAYMENTS_MARKUP_RATE = "-1";
    const { loadConfig } = await import("@/payments/credits/config");
    expect(() => loadConfig()).toThrow(/markup/i);
  });

  test("rejects zero creditsPerDollar", async () => {
    snap = snapshot();
    process.env.PAYMENTS_CREDITS_PER_DOLLAR = "0";
    const { loadConfig } = await import("@/payments/credits/config");
    expect(() => loadConfig()).toThrow(/creditsPerDollar/i);
  });

  test("rejects positive minBalance", async () => {
    snap = snapshot();
    process.env.PAYMENTS_MIN_BALANCE = "10";
    const { loadConfig } = await import("@/payments/credits/config");
    expect(() => loadConfig()).toThrow(/minBalance/i);
  });

  test("rejects non-numeric markup", async () => {
    snap = snapshot();
    process.env.PAYMENTS_MARKUP_RATE = "abc";
    const { loadConfig } = await import("@/payments/credits/config");
    expect(() => loadConfig()).toThrow();
  });
});
