export interface PaymentsConfig {
  markupRateBps: bigint;
  /**
   * Operator-configured markup as a canonical decimal string (e.g. "2"
   * for 2×). Snapshot for the consume ledger row so historical audits
   * can read what was applied without re-deriving from `markupRateBps`
   * (which is quantized and would lose digits beyond 4 decimal places).
   */
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

export const loadConfig = (): PaymentsConfig => {
  const markup = requireFloat(
    "PAYMENTS_MARKUP_RATE",
    process.env.PAYMENTS_MARKUP_RATE,
  );
  if (markup < 0) {
    throw new Error(`PAYMENTS_MARKUP_RATE markup must be >= 0: ${markup}`);
  }
  const markupRateBps = BigInt(Math.round(markup * 10000));
  const markupRate = String(markup);

  const cpd = requireInt(
    "PAYMENTS_CREDITS_PER_USD",
    process.env.PAYMENTS_CREDITS_PER_USD,
  );
  if (cpd <= 0) {
    throw new Error(
      `PAYMENTS_CREDITS_PER_USD creditsPerDollar must be > 0: ${cpd}`,
    );
  }
  const creditsPerDollar = BigInt(cpd);

  const rmt = requireInt(
    "PAYMENTS_RESERVED_MAX_TURN_CREDITS",
    process.env.PAYMENTS_RESERVED_MAX_TURN_CREDITS,
  );
  if (rmt < 0) {
    throw new Error(`PAYMENTS_RESERVED_MAX_TURN_CREDITS must be >= 0: ${rmt}`);
  }
  const reservedMaxTurnCredits = BigInt(rmt);

  const min = requireInt(
    "PAYMENTS_MIN_BALANCE_CREDITS",
    process.env.PAYMENTS_MIN_BALANCE_CREDITS,
  );
  if (min > 0) {
    throw new Error(
      `PAYMENTS_MIN_BALANCE_CREDITS minBalance must be <= 0: ${min}`,
    );
  }
  const minBalance = BigInt(min);

  return {
    markupRateBps,
    markupRate,
    creditsPerDollar,
    reservedMaxTurnCredits,
    minBalance,
  };
};

export const config: PaymentsConfig = loadConfig();
