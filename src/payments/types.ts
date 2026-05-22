import { z } from "zod";

export const GrantKindIdSchema = z.enum([
  "signup_bonus",
  "daily_refill",
  "manual",
]);
export type GrantKindId = z.infer<typeof GrantKindIdSchema>;

export const LedgerScopeSchema = z.enum([
  "transaction",
  "grant",
  "daily_refill",
]);
export type LedgerScope = z.infer<typeof LedgerScopeSchema>;

export type HistoryCursor = { createdAt: Date; id: string };

export type ConsumeResult = {
  spent: number;
  replayed: boolean;
  newBalance: bigint;
  balanceAfter: bigint; // snapshot from the inserted/replayed ledger row
  ledgerId: string;
};
export type GrantResult = {
  granted: number;
  replayed: boolean;
  newBalance: bigint;
  balanceAfter: bigint;
  ledgerId: string;
};
export type AdjustResult = {
  applied: true;
  replayed: boolean;
  newBalance: bigint;
  balanceAfter: bigint;
  ledgerId: string;
};
