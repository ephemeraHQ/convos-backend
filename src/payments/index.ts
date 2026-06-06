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
  getBucketedConsumption as ledgerGetBucketedConsumption,
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

const requireSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} must be a safe integer: ${value}`);
  }
};

export const consume = async (args: {
  accountId: string;
  usdCostMicros: bigint;
  idempotencyKey: string;
  requestId: string;
  model?: string;
}): Promise<ConsumeResult> => {
  const credits = usdToCredits(args.usdCostMicros);
  try {
    const { replayed, newBalance, balanceAfter, ledgerId } = await applyDelta({
      accountId: args.accountId,
      delta: BigInt(-credits),
      reason: LedgerReason.consume,
      idempotencyKey: args.idempotencyKey,
      scope: "transaction",
      usdCostMicros: args.usdCostMicros,
      markupRate: config.markupRate,
      creditsPerDollar: config.creditsPerDollar,
      model: args.model,
      requestId: args.requestId,
      floorCheck: { minBalance: config.minBalance },
    });
    return { spent: credits, replayed, newBalance, balanceAfter, ledgerId };
  } catch (err) {
    if (err instanceof LedgerFloorBreachError) {
      throw new InsufficientBalanceError(
        args.accountId,
        err.currentBalance,
        err.attempted,
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
  requireSafeInteger(args.credits, "grant credits");
  const parsedKindResult = GrantKindIdSchema.safeParse(args.kind);
  if (!parsedKindResult.success) {
    throw new ValidationError(`invalid grant kind: ${args.kind}`);
  }
  const parsedKind = parsedKindResult.data;

  const ledgerInput = {
    accountId: args.accountId,
    delta: BigInt(args.credits),
    reason: LedgerReason.grant,
    idempotencyKey: args.idempotencyKey,
    scope: "grant" as const,
    grantKindId: parsedKind,
    note: args.note,
    requestId: args.requestId,
  };

  // 1. Check for prior idempotent grant FIRST — before the active-kind check.
  //    If the kind was deactivated after the original grant, replaying the same
  //    idempotency key must still return the prior result, not GrantKindNotFoundError.
  const prior = await findLedgerByIdempotencyKey({
    accountId: args.accountId,
    idempotencyKey: args.idempotencyKey,
    scope: "grant",
  });
  if (prior) {
    validateReplayPayload(prior, ledgerInput);
    const balanceAfter =
      prior.balanceAfter ?? (await ledgerGetBalance(args.accountId));
    return {
      granted: args.credits,
      replayed: true,
      newBalance: balanceAfter,
      balanceAfter,
      ledgerId: prior.id,
    };
  }

  // 2. Active-kind check only applies on first grant, not on replay.
  try {
    const txResult = await prisma.$transaction(async (tx) => {
      const kindRow = await tx.grantKind.findUnique({
        where: { id: parsedKind },
        select: { id: true, active: true },
      });
      if (!kindRow || !kindRow.active) {
        throw new GrantKindNotFoundError(parsedKind);
      }
      return applyDeltaWithTx(tx, ledgerInput);
    });
    return {
      granted: args.credits,
      replayed: false,
      newBalance: txResult.newBalance,
      balanceAfter: txResult.balanceAfter,
      ledgerId: txResult.ledgerId,
    };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Race: another concurrent grant inserted the same key between our
      // pre-check and the transaction. Fall through to replay path.
      const racePrior = await findLedgerByIdempotencyKey({
        accountId: args.accountId,
        idempotencyKey: args.idempotencyKey,
        scope: "grant",
      });
      if (racePrior) {
        validateReplayPayload(racePrior, ledgerInput);
        const balanceAfter =
          racePrior.balanceAfter ?? (await ledgerGetBalance(args.accountId));
        return {
          granted: args.credits,
          replayed: true,
          newBalance: balanceAfter,
          balanceAfter,
          ledgerId: racePrior.id,
        };
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
  requireSafeInteger(args.delta, "adjust delta");
  const opts =
    args.delta < 0 ? { floorCheck: { minBalance: config.minBalance } } : {};
  try {
    const { replayed, newBalance, balanceAfter, ledgerId } = await applyDelta({
      accountId: args.accountId,
      delta: BigInt(args.delta),
      reason: LedgerReason.adjust,
      idempotencyKey: args.idempotencyKey,
      scope: "grant",
      note: args.note,
      ...opts,
    });
    return { applied: true, replayed, newBalance, balanceAfter, ledgerId };
  } catch (err) {
    if (err instanceof LedgerFloorBreachError) {
      throw new InsufficientBalanceError(
        args.accountId,
        err.currentBalance,
        err.attempted,
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

export type { ConsumptionBucketRow } from "./ledger/repository";

/** Consumed credits for an account on/after `since`, in UTC day/week/month buckets. */
export const getBucketedConsumption = async (
  accountId: string,
  since: Date,
  bucket: "day" | "week" | "month",
) => ledgerGetBucketedConsumption(accountId, since, bucket);
