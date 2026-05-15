import { LedgerReason, Prisma } from "@prisma/client";
import { ValidationError } from "@/utils/errors";
import { prisma } from "@/utils/prisma";
import { config, usdToCredits } from "./credits";
import { isAllowedFromBalance } from "./credits/policy";
import { GrantKindNotFoundError, InsufficientBalanceError } from "./errors";
import {
  applyDelta,
  applyDeltaWithTx,
  findLedgerByIdempotencyKey,
  LedgerFloorBreachError,
  getBalance as ledgerGetBalance,
  getHistory as ledgerGetHistory,
  validateReplayPayload,
} from "./ledger";
import {
  GrantKindIdSchema,
  type AdjustResult,
  type ConsumeResult,
  type GrantKindId,
  type GrantResult,
  type HistoryCursor,
} from "./types";

export type { GrantKindId, HistoryCursor } from "./types";
export {
  GrantKindNotFoundError,
  IdempotencyMismatchError,
  InsufficientBalanceError,
} from "./errors";
export { creditsToUsd, usdToCredits } from "./credits";

export const consume = async (args: {
  accountId: string;
  usdCostMicros: bigint;
  idempotencyKey: string;
  requestId: string;
  model?: string;
}): Promise<ConsumeResult> => {
  const credits = usdToCredits(args.usdCostMicros);
  try {
    const { replayed } = await applyDelta({
      accountId: args.accountId,
      delta: BigInt(-credits),
      reason: LedgerReason.consume,
      idempotencyKey: args.idempotencyKey,
      usdCostMicros: args.usdCostMicros,
      markupRate: config.markupRate,
      creditsPerDollar: config.creditsPerDollar,
      model: args.model,
      requestId: args.requestId,
      floorCheck: { minBalance: config.minBalance },
    });
    return { spent: credits, replayed };
  } catch (err) {
    if (err instanceof LedgerFloorBreachError) {
      throw new InsufficientBalanceError(
        args.accountId,
        err.currentBalance,
        Number(err.attempted),
        err.minBalance,
      );
    }
    throw err;
  }
};

/**
 * Grant credits to an account.
 *
 * Pricing snapshot fields (markupRate, creditsPerDollar) are NOT recorded
 * on grant ledger entries. Credit-denominated operations don't need pricing
 * snapshots because the credit value is captured directly in the delta field.
 * Conversion back to USD (if needed for display) uses current pricing.
 */
export const grant = async (args: {
  accountId: string;
  credits: number;
  idempotencyKey: string;
  kind: GrantKindId;
  note?: string;
  requestId?: string;
}): Promise<GrantResult> => {
  if (args.credits <= 0) {
    throw new ValidationError(`grant credits must be > 0: ${args.credits}`);
  }
  const parsedKind = GrantKindIdSchema.parse(args.kind);

  const ledgerInput = {
    accountId: args.accountId,
    delta: BigInt(args.credits),
    reason: LedgerReason.grant,
    idempotencyKey: args.idempotencyKey,
    grantKindId: parsedKind,
    note: args.note,
    requestId: args.requestId,
  };

  try {
    await prisma.$transaction(async (tx) => {
      const kindRow = await tx.grantKind.findUnique({
        where: { id: parsedKind },
        select: { id: true, active: true },
      });
      if (!kindRow || !kindRow.active) {
        throw new GrantKindNotFoundError(parsedKind);
      }
      return applyDeltaWithTx(tx, ledgerInput);
    });
    return { granted: args.credits, replayed: false };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const prior = await findLedgerByIdempotencyKey(
        args.accountId,
        args.idempotencyKey,
      );
      if (prior) {
        validateReplayPayload(prior, ledgerInput);
        return { granted: args.credits, replayed: true };
      }
    }
    throw err;
  }
};

/**
 * Manually adjust an account balance (positive or negative).
 *
 * Credit-denominated — no pricing snapshot needed. The delta field itself
 * is the complete record of the adjustment value.
 */
export const adjust = async (args: {
  accountId: string;
  delta: number;
  idempotencyKey: string;
  note: string;
}): Promise<AdjustResult> => {
  if (!args.note || !args.note.trim()) {
    throw new ValidationError("adjust note is required");
  }
  if (args.delta === 0) {
    throw new ValidationError("adjust delta must be non-zero");
  }
  const opts =
    args.delta < 0 ? { floorCheck: { minBalance: config.minBalance } } : {};
  try {
    const { replayed } = await applyDelta({
      accountId: args.accountId,
      delta: BigInt(args.delta),
      reason: LedgerReason.adjust,
      idempotencyKey: args.idempotencyKey,
      note: args.note,
      ...opts,
    });
    return { applied: true, replayed };
  } catch (err) {
    if (err instanceof LedgerFloorBreachError) {
      throw new InsufficientBalanceError(
        args.accountId,
        err.currentBalance,
        Number(err.attempted),
        err.minBalance,
      );
    }
    throw err;
  }
};

export const getBalance = async (accountId: string): Promise<bigint> =>
  ledgerGetBalance(accountId);

/**
 * Advisory balance check. NOT an authorization gate — only consume()
 * enforces the floor atomically. Use for UX hints (disable button).
 */
export const isAllowed = async (accountId: string): Promise<boolean> =>
  isAllowedFromBalance(await ledgerGetBalance(accountId));

export const getHistory = async (
  accountId: string,
  limit?: number,
  cursor?: HistoryCursor,
) => ledgerGetHistory(accountId, limit, cursor);
