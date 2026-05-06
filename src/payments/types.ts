import { z } from "zod";

export const GrantKindIdSchema = z.enum([
  "signup_bonus",
  "daily_refill",
  "manual",
]);
export type GrantKindId = z.infer<typeof GrantKindIdSchema>;

export type HistoryCursor = { createdAt: Date; id: string };

export type ConsumeResult = { spent: number };
export type GrantResult = { granted: number };
export type AdjustResult = { applied: true };
