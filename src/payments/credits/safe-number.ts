import { ValidationError } from "@/utils/errors";

/**
 * Convert a credit BigInt to a JS number, throwing if it falls outside the
 * safe-integer range (where `Number` would silently lose precision). Codifies
 * the inline guard already used in pricing.ts/config.ts so read paths that
 * surface credit totals as numbers can't truncate undetected.
 */
export const bigintToSafeNumber = (value: bigint, field: string): number => {
  const MAX = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > MAX || value < -MAX) {
    throw new ValidationError(`${field} exceeds safe integer range: ${value}`);
  }
  return Number(value);
};
