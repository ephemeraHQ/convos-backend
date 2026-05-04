import { LedgerReason, Prisma } from "@prisma/client";
import { prisma } from "@/utils/prisma";
import { config, isAllowedFromBalance, usdToCredits } from "./credits";
import { GrantKindNotFoundError, InsufficientBalanceError } from "./errors";
import {
  applyDelta,
  applyDeltaWithTx,
  findLedgerByIdempotencyKey,
  LedgerFloorBreachError,
  getBalance as ledgerGetBalance,
  getHistory as ledgerGetHistory,
} from "./ledger";
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

/**
 * Grant credits to an inbox.
 *
 * NOTE: Pricing snapshot fields (`markupRate`, `creditsPerDollar`) are NOT
 * recorded on grant ledger entries. This is acceptable while grants stay
 * credit-denominated. Future: if USD-denominated promo grants are introduced,
 * snapshot pricing at grant time so historical USD value is auditable.
 */
export const grant = async (
  inboxId: string,
  credits: number,
  idempotencyKey: string,
  kind: GrantKindId,
  opts?: { note?: string; requestId?: string },
): Promise<GrantResult> => {
  if (credits <= 0) {
    throw new Error(`grant credits must be > 0: ${credits}`);
  }
  // GrantKind active-check is done inside the same transaction as the ledger
  // write so a concurrent `active=false` flip cannot slip through between the
  // read and the write. The FK already prevents deleted kinds; this guards
  // against deactivation.
  try {
    const result = await prisma.$transaction(async (tx) => {
      const kindRow = await tx.grantKind.findUnique({
        where: { id: kind },
        select: { id: true, active: true },
      });
      if (!kindRow || !kindRow.active) {
        throw new GrantKindNotFoundError(kind);
      }
      return applyDeltaWithTx(tx, {
        inboxId,
        delta: credits,
        reason: LedgerReason.grant,
        idempotencyKey,
        grantKindId: kind,
        note: opts?.note,
        requestId: opts?.requestId,
      });
    });
    return { granted: credits, balance: result.balanceAfter };
  } catch (err) {
    // Idempotent replay: same (inboxId, idempotencyKey) returns the historical
    // ledger row instead of erroring. Mirrors the path in applyDelta().
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const prior = await findLedgerByIdempotencyKey(inboxId, idempotencyKey);
      if (prior) {
        return { granted: credits, balance: prior.balanceAfter };
      }
    }
    throw err;
  }
};

/**
 * Manually adjust an inbox balance (positive or negative).
 *
 * NOTE: Pricing snapshot fields (`markupRate`, `creditsPerDollar`) are NOT
 * recorded on adjust ledger entries. This is acceptable while adjustments stay
 * credit-denominated. Future: if USD-denominated adjustments are introduced,
 * snapshot pricing at adjust time so historical USD value is auditable.
 */
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
  const opts =
    delta < 0 ? { floorCheck: { minBalance: config.minBalance } } : {};
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

/**
 * Check whether the inbox currently has a sufficient balance to act.
 *
 * ADVISORY ONLY. Concurrent `consume` calls can invalidate the read between
 * the gate check and any subsequent action. Callers must NOT rely on this for
 * correctness — only `consume` itself enforces the floor atomically (via
 * `floorCheck` inside the applyDelta transaction). Suitable for UX hints
 * (e.g. disabling a button), NOT for authorization gates.
 */
export const isAllowed = async (inboxId: string): Promise<boolean> =>
  isAllowedFromBalance(await ledgerGetBalance(inboxId));

export const getHistory = async (
  inboxId: string,
  limit?: number,
  cursor?: HistoryCursor,
) => ledgerGetHistory(inboxId, limit, cursor);
