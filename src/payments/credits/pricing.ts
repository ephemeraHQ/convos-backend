import { ValidationError } from "@/utils/errors";
import { config } from "./config";

const MICROS_PER_USD = 1_000_000n;
const BPS_SCALE = 10000n;
const SCALE = BPS_SCALE * MICROS_PER_USD;

const ceilDiv = (num: bigint, den: bigint): bigint => {
  if (num <= 0n) return 0n;
  return (num + den - 1n) / den;
};

export const usdToCredits = (usdCostMicros: bigint): number => {
  if (usdCostMicros < 0n) {
    throw new ValidationError(`usdCostMicros must be >= 0: ${usdCostMicros}`);
  }
  const numerator =
    usdCostMicros * config.markupRateBps * config.creditsPerDollar;
  const credits = ceilDiv(numerator, SCALE);
  if (credits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError(
      `usdToCredits result exceeds safe integer range: ${credits}`,
    );
  }
  return Number(credits);
};

export const creditsToUsd = (credits: number): bigint => {
  if (credits < 0) {
    throw new ValidationError(`credits must be >= 0: ${credits}`);
  }
  if (!Number.isInteger(credits)) {
    throw new ValidationError(`credits must be an integer: ${credits}`);
  }
  if (!Number.isSafeInteger(credits)) {
    throw new ValidationError(`credits exceeds safe integer range: ${credits}`);
  }
  const denom = config.markupRateBps * config.creditsPerDollar;
  if (denom === 0n) return 0n;
  return (BigInt(credits) * SCALE) / denom;
};
