import { config } from "./config";

export const isAllowedFromBalance = (balance: bigint): boolean =>
  balance >= config.reservedMaxTurnCredits;
