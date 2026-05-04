export interface PaymentsConfig {
  markupRateBps: bigint;
  markupRate: string;
  creditsPerDollar: bigint;
  reservedMaxTurnCredits: bigint;
  minBalance: bigint;
}

const requireFloat = (key: string, raw: string | undefined): number => {
  if (raw === undefined || raw === "") {
    throw new Error(`${key} not configured`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${key} is not a finite number: ${raw}`);
  }
  return n;
};

const requireInt = (key: string, raw: string | undefined): number => {
  const n = requireFloat(key, raw);
  if (!Number.isInteger(n)) {
    throw new Error(`${key} must be an integer: ${raw}`);
  }
  return n;
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
    throw new Error(`PAYMENTS_MARKUP_RATE markup must be >= 0: ${markup}`);
  }
  return {
    markupRateBps: BigInt(Math.round(markup * 10000)),
    markupRate: String(markup),
  };
};

// PAYMENTS_CREDITS_PER_USD
//   Pricing constant: how many credits represent one US dollar. `1000`
//   means 1 credit = $0.001 (a tenth of a cent). Integer, must be > 0.
//   Used by usdToCredits / creditsToUsd and snapshotted on each consume
//   ledger row so historical USD value is reconstructable.
const loadCreditsPerUsd = (): bigint => {
  const cpd = requireInt(
    "PAYMENTS_CREDITS_PER_USD",
    process.env.PAYMENTS_CREDITS_PER_USD,
  );
  if (cpd <= 0) {
    throw new Error(
      `PAYMENTS_CREDITS_PER_USD creditsPerDollar must be > 0: ${cpd}`,
    );
  }
  return BigInt(cpd);
};

// PAYMENTS_RESERVED_MAX_TURN_CREDITS
//   Pre-call reservation budget in credits. `isAllowed` returns true
//   when balance > this value, so the caller can afford one expected
//   worst-case turn. `1` is permissive (any positive balance allows a
//   turn). Operator tunes upward for stricter gating. Integer, >= 0.
const loadReservedMaxTurnCredits = (): bigint => {
  const rmt = requireInt(
    "PAYMENTS_RESERVED_MAX_TURN_CREDITS",
    process.env.PAYMENTS_RESERVED_MAX_TURN_CREDITS,
  );
  if (rmt < 0) {
    throw new Error(`PAYMENTS_RESERVED_MAX_TURN_CREDITS must be >= 0: ${rmt}`);
  }
  return BigInt(rmt);
};

// PAYMENTS_MIN_BALANCE_CREDITS
//   Hard negative floor in credits. `consume` and negative `adjust`
//   throw InsufficientBalanceError if applying the delta would drive
//   balance below this. `-1000` (~ -$1 at default pricing) caps damage
//   from runaway agents while still permitting the documented
//   "1-turn over-spend" behavior. Integer, must be <= 0.
const loadMinBalanceCredits = (): bigint => {
  const min = requireInt(
    "PAYMENTS_MIN_BALANCE_CREDITS",
    process.env.PAYMENTS_MIN_BALANCE_CREDITS,
  );
  if (min > 0) {
    throw new Error(
      `PAYMENTS_MIN_BALANCE_CREDITS minBalance must be <= 0: ${min}`,
    );
  }
  return BigInt(min);
};

export const loadConfig = (): PaymentsConfig => ({
  ...loadMarkupRate(),
  creditsPerDollar: loadCreditsPerUsd(),
  reservedMaxTurnCredits: loadReservedMaxTurnCredits(),
  minBalance: loadMinBalanceCredits(),
});

export const config: PaymentsConfig = loadConfig();
