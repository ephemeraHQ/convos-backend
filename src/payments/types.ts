import { z } from "zod";

export const GrantKindIdSchema = z.enum([
  "signup_bonus",
  "daily_refill",
  "manual",
  // Subscription period allotment, written as a real `grant` ledger row on
  // subscribe and on every renewal (single-ledger model).
  "sub_grant",
  // Bounded clawback of the unused subscription portion on expiry/refund/
  // revoke. Negative-delta adjustment; never wipes admin/promo/signup credits.
  "sub_forfeit",
]);
export type GrantKindId = z.infer<typeof GrantKindIdSchema>;

export const LedgerScopeSchema = z.enum([
  "transaction",
  "grant",
  "daily_refill",
  // Forfeit adjustment scope (negative subscription clawback).
  "sub_forfeit",
  // Lineage custody moves (subscription restoration/escrow/refund
  // compensation), keyed per journal row.
  "sub_transfer",
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
