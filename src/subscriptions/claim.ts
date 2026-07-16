import { randomUUID } from "node:crypto";
import type { Prisma, Subscription } from "@prisma/client";
import { requireLiveAccount } from "@/accounts/require-live-account";
import { isTombstoneClaimEnabled } from "@/subscriptions/claim-flags";
import {
  CUSTODY_STATE_ESCROW,
  exhaustCustody,
  releaseCustody,
} from "@/subscriptions/custody";
import {
  LINEAGE_STATE_LIVE,
  LINEAGE_STATE_TOMBSTONED,
  lockLineage,
  type LineageLockContext,
} from "@/subscriptions/lineage";
import { withDeadlockRetry } from "@/utils/deadlock-retry";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Subscription claim execution for tombstone restoration. The caller has
 * already verified the provider proof and resolved the lineage; this module
 * owns the transactional escrow release and restoration state change. Claims
 * against live lineages fail closed.
 *
 * Lock order per src/subscriptions/AGENTS.md: lineage -> accounts (sorted)
 * -> subscription -> wallets (sorted, via custody ops).
 */

export type ClaimRejectionReason = "transfer_frozen" | "lineage_unresolved";

export type ClaimExecutionResult =
  | { kind: "restored"; subscription: Subscription; releasedCredits: bigint }
  | { kind: "replayed"; subscription: Subscription }
  | { kind: "rejected"; reason: ClaimRejectionReason }
  | { kind: "not_found" };

type TxClient = Prisma.TransactionClient;

/** Data used to mint the fresh Subscription row on tombstone restoration. */
export type ClaimSubscriptionSeed = Omit<
  Prisma.SubscriptionUncheckedCreateInput,
  "accountId" | "lineageId"
>;

const markLineageRestored = async (
  tx: TxClient,
  ctx: LineageLockContext,
  journalId: string,
): Promise<void> => {
  await tx.subscriptionLineage.update({
    where: { id: ctx.lineageId },
    data: {
      lastTransferAt: new Date(),
      lastTransferJournalId: journalId,
      state: LINEAGE_STATE_LIVE,
      tombstonedAt: null,
      deletedAccountRef: null,
    },
  });
};

export const executeClaim = async (args: {
  callerAccountId: string;
  lineageId: string;
  /** Provider-verified current period window (authoritative lookup). */
  currentPeriodStart: Date;
  /** Exact funding-event key of the provider-verified current period. */
  providerPeriodKey: string;
  /** Fresh Subscription row fields for the restoration path. */
  subscriptionSeed: ClaimSubscriptionSeed;
  providerProof: Prisma.InputJsonValue;
}): Promise<ClaimExecutionResult> => {
  const { lineageId } = args;

  return withDeadlockRetry(
    () =>
      prisma.$transaction(
        async (tx) => {
          const ctx = await lockLineage(tx, lineageId);
          const lineage = await tx.subscriptionLineage.findUnique({
            where: { id: lineageId },
          });
          if (!lineage) return { kind: "not_found" as const };

          if (lineage.state === LINEAGE_STATE_TOMBSTONED) {
            return restoreTombstonedLineage(tx, ctx, args);
          }

          const subscription = await tx.subscription.findFirst({
            where: { lineageId },
          });
          if (!subscription) return { kind: "not_found" as const };
          if (subscription.accountId === args.callerAccountId) {
            return { kind: "replayed" as const, subscription };
          }

          return { kind: "rejected" as const, reason: "transfer_frozen" };
        },
        { timeout: 30_000 },
      ),
    { label: "execute_claim" },
  );
};

const restoreTombstonedLineage = async (
  tx: TxClient,
  ctx: LineageLockContext,
  args: {
    callerAccountId: string;
    currentPeriodStart: Date;
    /** Exact funding-event key of the provider-verified current period. */
    providerPeriodKey: string;
    subscriptionSeed: ClaimSubscriptionSeed;
    providerProof: Prisma.InputJsonValue;
  },
): Promise<ClaimExecutionResult> => {
  if (!isTombstoneClaimEnabled()) {
    return { kind: "rejected", reason: "transfer_frozen" };
  }
  await requireLiveAccount(tx, args.callerAccountId);

  // Defensive replay: a row on a tombstoned lineage means a concurrent
  // restore already ran; converge.
  const existing = await tx.subscription.findFirst({
    where: { lineageId: ctx.lineageId },
  });
  if (existing) {
    if (existing.accountId === args.callerAccountId) {
      return { kind: "replayed", subscription: existing };
    }
    return { kind: "rejected", reason: "transfer_frozen" };
  }

  // Restoration = escrow release, not a grant: the period's funding-registry
  // row already exists. Release ONLY the escrow row for the provider-verified
  // current funding event, selected by its exact provider period key rather
  // than by window arithmetic. The window fallback applies only to custody
  // bootstrapped from pre-lineage periods. Stale escrow rows release nothing
  // and past ones are exhausted.
  const escrows = await tx.lineagePeriodCustody.findMany({
    where: { lineageId: ctx.lineageId, state: CUSTODY_STATE_ESCROW },
  });
  const releaseTarget =
    escrows.find(
      (custody) => custody.providerPeriodKey === args.providerPeriodKey,
    ) ??
    escrows.find(
      (custody) =>
        custody.providerPeriodKey.startsWith("legacy_") &&
        custody.periodStart.getTime() <= args.currentPeriodStart.getTime() &&
        custody.periodEnd.getTime() > args.currentPeriodStart.getTime(),
    ) ??
    null;

  // Fail closed when the provider-proven current funding event has no
  // custody row on this lineage (e.g. the renewal notification that would
  // have funded escrow was lost while tombstoned). Restoring anyway would
  // silently mint a live lineage holding zero credits for a period the
  // provider says is paid - and the drift sweep, seeing "entitled", would
  // never backfill it. Park for an operator (alerted) and reject retryably.
  if (!releaseTarget) {
    const quarantineToken =
      args.subscriptionSeed.purchaseToken ??
      args.subscriptionSeed.originalTransactionId ??
      args.providerPeriodKey;
    const alreadyParked = await tx.lineageQuarantine.findFirst({
      where: {
        token: quarantineToken,
        reason: "restoration_missing_funding_event",
        resolvedAt: null,
      },
      select: { id: true },
    });
    if (!alreadyParked) {
      await tx.lineageQuarantine.create({
        data: {
          provider: args.subscriptionSeed.provider,
          token: quarantineToken,
          reason: "restoration_missing_funding_event",
          payload: {
            lineageId: ctx.lineageId,
            providerPeriodKey: args.providerPeriodKey,
            callerAccountId: args.callerAccountId,
          },
        },
      });
    }
    logger.error(
      {
        lineageId: ctx.lineageId,
        providerPeriodKey: args.providerPeriodKey,
      },
      "subscription.claim.restoration_missing_funding_event",
    );
    return { kind: "rejected", reason: "lineage_unresolved" };
  }

  const journalId = randomUUID();
  const subscription = await tx.subscription.create({
    data: {
      ...args.subscriptionSeed,
      accountId: args.callerAccountId,
      lineageId: ctx.lineageId,
    },
  });

  let released = 0n;
  for (const custody of escrows) {
    if (custody.id === releaseTarget.id) {
      released += await releaseCustody(tx, ctx, {
        custody,
        toAccountId: args.callerAccountId,
        journalId,
      });
    } else if (custody.periodEnd.getTime() <= Date.now()) {
      await exhaustCustody(tx, custody);
    }
  }

  await tx.subscriptionTransfer.create({
    data: {
      id: journalId,
      lineageId: ctx.lineageId,
      kind: "restore",
      status: "committed",
      toAccountId: args.callerAccountId,
      conservedCredits: released,
      providerProof: args.providerProof,
    },
  });
  await markLineageRestored(tx, ctx, journalId);

  logger.info(
    {
      lineageId: ctx.lineageId,
      journalId,
      released: released.toString(),
    },
    "subscription.claim.restored",
  );
  return { kind: "restored", subscription, releasedCredits: released };
};
