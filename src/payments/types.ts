export type GrantKindId = "signup_bonus" | "daily_refill" | "manual";

export type HistoryCursor = { createdAt: Date; id: string };

export type ConsumeResult = { spent: number; balance: bigint };
export type GrantResult = { granted: number; balance: bigint };
export type AdjustResult = { balance: bigint };
