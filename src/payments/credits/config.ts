import { ValidationError } from "@/utils/errors";

export interface PaymentsConfig {
  markupRateBps: bigint;
  markupRate: string;
  creditsPerDollar: bigint;
  reservedMaxTurnCredits: bigint;
  minBalance: bigint;
  freeTierDailyCapCredits: number;
  signupBonusCredits: number;
  grantPlusMonthlyCredits: number;
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
  const big = requireBigInt(
    "PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS",
    process.env.PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS,
  );
  if (big <= 0n || big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError(
      `PAYMENTS_FREE_TIER_DAILY_CAP_CREDITS must be a positive safe integer, got: ${big}`,
    );
  }
  return Number(big);
};

// PAYMENTS_SIGNUP_BONUS_CREDITS
//   One-time bonus granted on first account creation (SIWE upgrade).
//   OPTIONAL by design: unset/empty/"0" => 0 => feature disabled (kill-switch).
//   Any other value must be a non-negative safe integer. Do NOT convert this
//   to a require* loader; "unset = off" is the intended contract.
export const loadSignupBonusCredits = (): number => {
  const raw = process.env.PAYMENTS_SIGNUP_BONUS_CREDITS;
  if (raw === undefined || raw.trim() === "") {
    return 0;
  }
  const trimmed = raw.trim();
  if (
    !/^\d+$/.test(trimmed) ||
    BigInt(trimmed) > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ValidationError(
      `PAYMENTS_SIGNUP_BONUS_CREDITS must be a non-negative safe integer, got: ${raw}`,
    );
  }
  return Number(trimmed);
};

// PAYMENTS_GRANT_PLUS_MONTHLY
//   Monthly credit allotment for the Plus subscription tier. The source of
//   truth for `monthlyGrant` in the iOS `CreditBalance` model and the per-
//   period `sub_grant` ledger write. `tierGrant()` (tier-config.ts) reads it
//   lazily and would 500 on the first subscriber grant if unset; validating it
//   here makes a missing/non-numeric value fail fast at boot instead. Must be a
//   positive safe integer.
//
//   Parsing intentionally mirrors tier-config.ts's `Number.parseInt(raw, 10)`
//   (NOT the stricter `/^-?\d+$/` requireBigInt) so that any value which booted
//   the lazy `tierGrant()` path before — e.g. "500000\n", "500000 ", or a
//   trailing-garbage form parseInt tolerates — still boots here. The boot
//   validation must not be a regression that rejects a value the running system
//   already accepted; it only moves the same failure (unset / non-numeric /
//   non-positive) earlier.
export const loadGrantPlusMonthlyCredits = (): number => {
  const key = "PAYMENTS_GRANT_PLUS_MONTHLY";
  const raw = process.env.PAYMENTS_GRANT_PLUS_MONTHLY;
  if (raw === undefined || raw.trim() === "") {
    throw new ValidationError(`${key} not configured`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new ValidationError(
      `${key} must be a positive safe integer, got: ${raw}`,
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
  signupBonusCredits: loadSignupBonusCredits(),
  grantPlusMonthlyCredits: loadGrantPlusMonthlyCredits(),
});

export const config: PaymentsConfig = loadConfig();
