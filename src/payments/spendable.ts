import { LedgerReason } from "@prisma/client";
import { consume, getBalance } from "@/payments";
import { config } from "@/payments/credits/config";
import type { ConsumeResult } from "@/payments/types";
import { prisma } from "@/utils/prisma";

export const sumPeriodConsumes = async (
  accountId: string,
  since: Date,
): Promise<number> => {
  const agg = await prisma.creditLedger.aggregate({
    where: {
      accountId,
      reason: LedgerReason.consume,
      createdAt: { gte: since },
    },
    _sum: { delta: true },
  });
  const sum = agg._sum.delta;
  if (sum === null) return 0;
  return Number(sum < 0n ? -sum : sum);
};

/**
 * Spendable balance == the one wallet, for everyone.
 *
 * Single-ledger migration: subscriptions write real `sub_grant` credit rows
 * into `UserCredits.balance` on subscribe/renewal (and a bounded
 * `subscription_forfeit` on expiry), so there is no longer a derived
 * `tierGrant − periodConsumes` path or a bimodal switch on
 * `isEntitledSubscription`. Subscribers and non-subscribers read the same
 * wallet. Kept as a named export (rather than inlining `getBalance` at every
 * call site) so the agent gate and admin view keep their stable import.
 */
export const getSpendableBalance = async (accountId: string): Promise<bigint> =>
  getBalance(accountId);

export const isSpendAllowed = async (accountId: string): Promise<boolean> =>
  (await getSpendableBalance(accountId)) >= config.reservedMaxTurnCredits;

/**
 * Record a consume against the one wallet — a real, floor-checked decrement
 * for everyone (subscribers included). The subscriber `recordOnly` no-mutation
 * special case is gone: with subscription credits living in the wallet, there
 * is one debit path.
 */
export const recordConsume = async (args: {
  accountId: string;
  usdCostMicros: bigint;
  idempotencyKey: string;
  requestId: string;
  model?: string;
}): Promise<ConsumeResult> => consume(args);
