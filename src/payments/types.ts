import { z } from "zod";

export const GrantKindIdSchema = z.enum([
  "signup_bonus",
  "daily_refill",
  "manual",
]);
export type GrantKindId = z.infer<typeof GrantKindIdSchema>;

export type HistoryCursor = { createdAt: Date; id: string };

export type ConsumeResult = {
  spent: number;
  replayed: boolean;
  newBalance: bigint;
};
export type GrantResult = {
  granted: number;
  replayed: boolean;
  newBalance: bigint;
};
export type AdjustResult = {
  applied: true;
  replayed: boolean;
  newBalance: bigint;
};
