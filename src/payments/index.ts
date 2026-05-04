import { LedgerReason } from "@prisma/client";
import {
  config,
  isAllowedFromBalance,
  usdToCredits,
} from "./credits";
import {
  GrantKindNotFoundError,
  InsufficientBalanceError,
} from "./errors";
import {
  applyDelta,
  getBalance as ledgerGetBalance,
  getHistory as ledgerGetHistory,
  LedgerFloorBreachError,
} from "./ledger";
import { prisma } from "@/utils/prisma";
import type {
  AdjustResult,
  ConsumeResult,
  GrantKindId,
  GrantResult,
  HistoryCursor,
} from "./types";

export type { GrantKindId, HistoryCursor } from "./types";
export { GrantKindNotFoundError, InsufficientBalanceError } from "./errors";
export { creditsToUsd, usdToCredits } from "./credits";

export const consume = async (
  inboxId: string,
  usdCostMicros: bigint,
  idempotencyKey: string,
  requestId: string,
  opts?: { model?: string },
): Promise<ConsumeResult> => {
  const credits = usdToCredits(usdCostMicros);
  try {
    const result = await applyDelta({
      inboxId,
      delta: -credits,
      reason: LedgerReason.consume,
      idempotencyKey,
      usdCostMicros,
      markupRate: (Number(config.markupRateBps) / 10000).toString(),
      creditsPerDollar: Number(config.creditsPerDollar),
      model: opts?.model,
      requestId,
      floorCheck: { minBalance: config.minBalance },
    });
    return { spent: credits, balance: result.balanceAfter };
  } catch (err) {
    if (err instanceof LedgerFloorBreachError) {
      throw new InsufficientBalanceError(
        inboxId,
        err.currentBalance,
        err.attempted,
        err.minBalance,
      );
    }
    throw err;
  }
};

export const grant = async (
  inboxId: string,
  credits: number,
  idempotencyKey: string,
  kind: GrantKindId,
  opts?: { note?: string; requestId?: string },
): Promise<GrantResult> => {
  const kindRow = await prisma.grantKind.findUnique({
    where: { id: kind },
    select: { id: true, active: true },
  });
  if (!kindRow || !kindRow.active) {
    throw new GrantKindNotFoundError(kind);
  }
  if (credits <= 0) {
    throw new Error(`grant credits must be > 0: ${credits}`);
  }
  const result = await applyDelta({
    inboxId,
    delta: credits,
    reason: LedgerReason.grant,
    idempotencyKey,
    grantKindId: kind,
    note: opts?.note,
    requestId: opts?.requestId,
  });
  return { granted: credits, balance: result.balanceAfter };
};

export const adjust = async (
  inboxId: string,
  delta: number,
  idempotencyKey: string,
  note: string,
): Promise<AdjustResult> => {
  if (!note || !note.trim()) {
    throw new Error("adjust note is required");
  }
  if (delta === 0) {
    throw new Error("adjust delta must be non-zero");
  }
  const opts = delta < 0 ? { floorCheck: { minBalance: config.minBalance } } : {};
  try {
    const result = await applyDelta({
      inboxId,
      delta,
      reason: LedgerReason.adjust,
      idempotencyKey,
      note,
      ...opts,
    });
    return { balance: result.balanceAfter };
  } catch (err) {
    if (err instanceof LedgerFloorBreachError) {
      throw new InsufficientBalanceError(
        inboxId,
        err.currentBalance,
        err.attempted,
        err.minBalance,
      );
    }
    throw err;
  }
};

export const getBalance = async (inboxId: string): Promise<bigint> =>
  ledgerGetBalance(inboxId);

export const isAllowed = async (inboxId: string): Promise<boolean> =>
  isAllowedFromBalance(await ledgerGetBalance(inboxId));

export const getHistory = async (
  inboxId: string,
  limit?: number,
  cursor?: HistoryCursor,
) => ledgerGetHistory(inboxId, limit, cursor);
