import { ValidationError } from "@/utils/errors";

export interface PaymentsConfig {
  markupRateBps: bigint;
  markupRate: string;
  creditsPerDollar: bigint;
  reservedMaxTurnCredits: bigint;
  minBalance: bigint;
  freeTierDailyCapCredits: number;
}

const requireFloat = (key: string, raw: string | undefined): number => {
  if (raw === undefined || raw === "") {
    throw new ValidationError(`${key} not configured`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ValidationError(`${key} is not a finite number: ${raw}`);
  }
  return n;
};

const requireBigInt = (key: string, raw: string | undefined): bigint => {
  if (raw === undefined || raw.trim() === "") {
    throw new ValidationError(`${key} not configured`);
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ValidationError(`${key} must be an integer: ${raw}`);
  }
  return BigInt(trimmed);
};

// PAYMENTS_MARKUP_RATE
//   Dimensionless multiplier applied to upstream USD cost when computing
//   the credit charge. `2.0` means "charge the user 2× the raw model
//   cost". Float, parsed and quantized to basis points at config load.
//   Must be >= 0.
const loadMarkupRate = (): Pick<
  PaymentsConfig,
  "markupRateBps" | "markupRate"
> => {
  const markup = requireFloat(
    "PAYMENTS_MARKUP_RATE",
    process.env.PAYMENTS_MARKUP_RATE,
  );
  if (markup < 0) {
    throw new ValidationError(
      `PAYMENTS_MARKUP_RATE must be >= 0, got: ${markup}`,
    );
  }
  return {
    markupRateBps: BigInt(Math.round(markup * 10000)),
    markupRate: String(markup),
  };
};

// PAYMENTS_CREDITS_PER_USD
//   How many credits represent one US dollar. Credit-denominated operations
//   (grant, adjust) don't need pricing snapshots because the credit value
//   is captured directly in the delta field. Conversion back to USD (if
//   needed for display or reporting) uses current pricing, not historical.
//   Integer, must be > 0.
const loadCreditsPerUsd = (): bigint => {
  const cpd = requireBigInt(
    "PAYMENTS_CREDITS_PER_USD",
    process.env.PAYMENTS_CREDITS_PER_USD,
  );
  if (cpd <= 0n) {
    throw new ValidationError(
      `PAYMENTS_CREDITS_PER_USD must be > 0, got: ${cpd}`,
    );
  }
  return cpd;
};

// PAYMENTS_RESERVED_MAX_TURN_CREDITS
//   Pre-call reservation budget in credits. `isAllowed` returns true
//   when balance > this value, so the caller can afford one expected
//   worst-case turn. `1` is permissive (any positive balance allows a
//   turn). Operator tunes upward for stricter gating. Integer, >= 0.
const loadReservedMaxTurnCredits = (): bigint => {
  const rmt = requireBigInt(
    "PAYMENTS_RESERVED_MAX_TURN_CREDITS",
    process.env.PAYMENTS_RESERVED_MAX_TURN_CREDITS,
  );
  if (rmt < 0n) {
    throw new ValidationError(
      `PAYMENTS_RESERVED_MAX_TURN_CREDITS must be >= 0: ${rmt}`,
    );
  }
  return rmt;
};

// PAYMENTS_MIN_BALANCE_CREDITS
//   Hard negative floor in credits. `consume` and negative `adjust`
//   throw InsufficientBalanceError if applying the delta would drive
//   balance below this. `-1000` (~ -$1 at default pricing) caps damage
//   from runaway agents while still permitting the documented
//   "1-turn over-spend" behavior. Integer, must be <= 0.
const loadMinBalanceCredits = (): bigint => {
  const min = requireBigInt(
    "PAYMENTS_MIN_BALANCE_CREDITS",
    process.env.PAYMENTS_MIN_BALANCE_CREDITS,
  );
  if (min > 0n) {
    throw new ValidationError(
      `PAYMENTS_MIN_BALANCE_CREDITS must be <= 0, got: ${min}`,
    );
  }
  return min;
};

// PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS
//   Daily top-up-to-cap amount applied by the /credits/daily cron to
//   SIWE-verified non-subscriber accounts. Must be a positive integer.
export const loadFreeTierDailyCapCredits = (): number => {
  const raw = process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS;
  if (raw === undefined || raw.trim() === "") {
    throw new ValidationError(
      "PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS not configured",
    );
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ValidationError(
      `PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS must be an integer: ${raw}`,
    );
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ValidationError(
      `PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS must be > 0, got: ${n}`,
    );
  }
  return n;
};

export const loadConfig = (): PaymentsConfig => ({
  ...loadMarkupRate(),
  creditsPerDollar: loadCreditsPerUsd(),
  reservedMaxTurnCredits: loadReservedMaxTurnCredits(),
  minBalance: loadMinBalanceCredits(),
  freeTierDailyCapCredits: loadFreeTierDailyCapCredits(),
});

export const config: PaymentsConfig = loadConfig();
