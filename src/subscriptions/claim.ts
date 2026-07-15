import { randomUUID } from "node:crypto";
import type { Prisma, Subscription } from "@prisma/client";
import { requireLiveAccount } from "@/accounts/require-live-account";
import {
  claimContestWindowHours,
  isLiveTransferEnabled,
  isTombstoneClaimEnabled,
  SUBSCRIPTION_CLAIM_COOLDOWN_DAYS,
  SUBSCRIPTION_CLAIM_UNDO_DEADLINE_DAYS,
} from "@/subscriptions/claim-flags";
import {
  bootstrapLegacyCustody,
  CUSTODY_STATE_ESCROW,
  CUSTODY_STATE_HELD,
  exhaustCustody,
  findCustodyCovering,
  releaseCustody,
  transferCustody,
} from "@/subscriptions/custody";
import {
  LINEAGE_STATE_LIVE,
  LINEAGE_STATE_TOMBSTONED,
  lockLineage,
  type LineageLockContext,
} from "@/subscriptions/lineage";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Subscription claim execution: tombstone restoration (escrow release) and
 * live bearer-transfer with contest window, one-shot undo, cooldown, and
 * post-undo freeze. The caller (HTTP handler) has already verified provider
 * proof — authoritative entitled-now + latest-transaction match — and
 * resolved the lineage; this module owns the transactional state machine.
 *
 * Lock order per src/subscriptions/AGENTS.md: lineage -> accounts (sorted)
 * -> subscription -> wallets (sorted, via custody ops).
 */

export type ClaimRejectionReason =
  | "not_entitled"
  | "cooldown"
  | "undo_consumed"
  | "transfer_frozen"
  | "lineage_unresolved"
  | "pending_contest";

export type ClaimExecutionResult =
  | { kind: "restored"; subscription: Subscription; releasedCredits: bigint }
  | { kind: "transferred"; subscription: Subscription; conserved: bigint }
  | { kind: "replayed"; subscription: Subscription }
  | { kind: "pending"; contestEndsAt: Date; oldAccountId: string }
  | { kind: "rejected"; reason: ClaimRejectionReason }
  | { kind: "not_found" };

const COOLDOWN_MS = SUBSCRIPTION_CLAIM_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const UNDO_DEADLINE_MS =
  SUBSCRIPTION_CLAIM_UNDO_DEADLINE_DAYS * 24 * 60 * 60 * 1000;

type TxClient = Prisma.TransactionClient;

/** Data used to mint the fresh Subscription row on tombstone restoration. */
export type ClaimSubscriptionSeed = Omit<
  Prisma.SubscriptionUncheckedCreateInput,
  "accountId" | "lineageId"
>;

const stampLineage = async (
  tx: TxClient,
  ctx: LineageLockContext,
  args: { journalId: string; freeze?: boolean; state?: string },
): Promise<void> => {
  await tx.subscriptionLineage.update({
    where: { id: ctx.lineageId },
    data: {
      lastTransferAt: new Date(),
      lastTransferJournalId: args.journalId,
      ...(args.freeze ? { liveTransferFrozenAt: new Date() } : {}),
      ...(args.state === LINEAGE_STATE_LIVE
        ? {
            state: LINEAGE_STATE_LIVE,
            tombstonedAt: null,
            deletedAccountRef: null,
          }
        : {}),
    },
  });
};

const custodyForSubscription = async (
  tx: TxClient,
  ctx: LineageLockContext,
  subscription: Subscription,
) =>
  (await findCustodyCovering(tx, ctx, new Date(), [CUSTODY_STATE_HELD])) ??
  bootstrapLegacyCustody(tx, ctx, {
    subscriptionId: subscription.id,
    ownerAccountId: subscription.accountId,
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
  });

export const executeClaim = async (args: {
  callerAccountId: string;
  lineageId: string;
  /** Provider-verified current period window (authoritative lookup). */
  currentPeriodStart: Date;
  /** Fresh Subscription row fields for the restoration path. */
  subscriptionSeed: ClaimSubscriptionSeed;
  providerProof: Prisma.InputJsonValue;
}): Promise<ClaimExecutionResult> => {
  const { callerAccountId, lineageId } = args;

  return prisma.$transaction(
    async (tx) => {
      const ctx = await lockLineage(tx, lineageId);
      const lineage = await tx.subscriptionLineage.findUnique({
        where: { id: lineageId },
      });
      if (!lineage) return { kind: "not_found" as const };

      if (lineage.state === LINEAGE_STATE_TOMBSTONED) {
        return restoreTombstonedLineage(tx, ctx, args);
      }

      // Live lineage.
      const row = await tx.subscription.findFirst({ where: { lineageId } });
      if (!row) return { kind: "not_found" as const };
      if (row.accountId === callerAccountId) {
        return { kind: "replayed" as const, subscription: row };
      }

      // One-shot undo: only the immediately previous owner, only while the
      // transfer is unconsumed and inside the deadline. Executes
      // immediately (an attacker can never be the previous owner of their
      // own theft, and holding the victim's recovery behind a contest
      // window would only extend attacker spend), then freezes the lineage.
      const lastTransfer = await tx.subscriptionTransfer.findFirst({
        where: { lineageId, kind: "transfer", status: "committed" },
        orderBy: { createdAt: "desc" },
      });
      const undoTarget =
        lastTransfer &&
        lastTransfer.fromAccountId === callerAccountId &&
        lastTransfer.undoneByTransferId === null &&
        lastTransfer.undoDeadlineAt !== null &&
        lastTransfer.undoDeadlineAt.getTime() > Date.now()
          ? lastTransfer
          : null;

      if (undoTarget) {
        if (lineage.liveTransferFrozenAt) {
          return { kind: "rejected" as const, reason: "transfer_frozen" };
        }
        const journalId = randomUUID();
        // The one-shot CAS: zero rows updated means another undo consumed it.
        const cas = await tx.subscriptionTransfer.updateMany({
          where: { id: undoTarget.id, undoneByTransferId: null },
          data: { undoneByTransferId: journalId },
        });
        if (cas.count === 0) {
          return { kind: "rejected" as const, reason: "undo_consumed" };
        }
        const conserved = await executeOwnershipMove(tx, ctx, {
          journalId,
          kind: "undo",
          row,
          toAccountId: callerAccountId,
          undoOfTransferId: undoTarget.id,
          providerProof: args.providerProof,
        });
        // Post-undo freeze: an executed undo is an abuse tripwire; further
        // automated live transfers need an operator.
        await stampLineage(tx, ctx, { journalId, freeze: true });
        const updated = await tx.subscription.findUniqueOrThrow({
          where: { id: row.id },
        });
        logger.warn(
          { lineageId, journalId, conserved: conserved.toString() },
          "subscription.claim.undo",
        );
        return {
          kind: "transferred" as const,
          subscription: updated,
          conserved,
        };
      }

      // Plain live transfer.
      if (!isLiveTransferEnabled() || lineage.liveTransferFrozenAt) {
        return { kind: "rejected" as const, reason: "transfer_frozen" };
      }
      const pending = await tx.subscriptionTransfer.findFirst({
        where: { lineageId, status: "pending" },
      });
      if (pending) {
        return { kind: "rejected" as const, reason: "pending_contest" };
      }
      if (
        lineage.lastTransferAt &&
        Date.now() - lineage.lastTransferAt.getTime() < COOLDOWN_MS
      ) {
        return { kind: "rejected" as const, reason: "cooldown" };
      }

      const windowHours = claimContestWindowHours();
      if (windowHours > 0) {
        const contestEndsAt = new Date(
          Date.now() + windowHours * 60 * 60 * 1000,
        );
        await tx.subscriptionTransfer.create({
          data: {
            lineageId,
            kind: "transfer",
            status: "pending",
            fromAccountId: row.accountId,
            toAccountId: callerAccountId,
            providerProof: args.providerProof,
            contestEndsAt,
          },
        });
        return {
          kind: "pending" as const,
          contestEndsAt,
          oldAccountId: row.accountId,
        };
      }

      // Contest window disabled (requires explicit security acceptance):
      // instant transfer.
      const journalId = randomUUID();
      const conserved = await executeOwnershipMove(tx, ctx, {
        journalId,
        kind: "transfer",
        row,
        toAccountId: callerAccountId,
        providerProof: args.providerProof,
      });
      await stampLineage(tx, ctx, { journalId });
      const updated = await tx.subscription.findUniqueOrThrow({
        where: { id: row.id },
      });
      logger.warn(
        { lineageId, journalId, conserved: conserved.toString() },
        "subscription.claim.granted",
      );
      return { kind: "transferred" as const, subscription: updated, conserved };
    },
    { timeout: 30_000 },
  );
};

/** Shared committed-move body for transfer and undo. */
const executeOwnershipMove = async (
  tx: TxClient,
  ctx: LineageLockContext,
  args: {
    journalId: string;
    kind: "transfer" | "undo";
    row: Subscription;
    toAccountId: string;
    undoOfTransferId?: string;
    providerProof: Prisma.InputJsonValue;
  },
): Promise<bigint> => {
  // Lock order rule 2: accounts sorted by id.
  const accountIds = [args.row.accountId, args.toAccountId].sort();
  for (const accountId of accountIds) {
    await requireLiveAccount(tx, accountId);
  }
  const custody = await custodyForSubscription(tx, ctx, args.row);
  const journalData = {
    lineageId: ctx.lineageId,
    kind: args.kind,
    status: "committed",
    fromAccountId: args.row.accountId,
    toAccountId: args.toAccountId,
    providerProof: args.providerProof,
    undoOfTransferId: args.undoOfTransferId ?? null,
    // Undo journal rows are never themselves undoable: no deadline.
    undoDeadlineAt:
      args.kind === "transfer" ? new Date(Date.now() + UNDO_DEADLINE_MS) : null,
  };
  // A settling pending transfer reuses its journal row (one row per
  // transfer); direct claims create a fresh one.
  await tx.subscriptionTransfer.upsert({
    where: { id: args.journalId },
    update: journalData,
    create: { id: args.journalId, ...journalData },
  });
  const conserved = custody
    ? await transferCustody(tx, ctx, {
        custody,
        toAccountId: args.toAccountId,
        journalId: args.journalId,
      })
    : 0n;
  await tx.subscriptionTransfer.update({
    where: { id: args.journalId },
    data: { conservedCredits: conserved },
  });
  await tx.subscription.update({
    where: { id: args.row.id },
    data: { accountId: args.toAccountId },
  });
  return conserved;
};

const restoreTombstonedLineage = async (
  tx: TxClient,
  ctx: LineageLockContext,
  args: {
    callerAccountId: string;
    currentPeriodStart: Date;
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
    return { kind: "rejected", reason: "pending_contest" };
  }

  const journalId = randomUUID();
  const subscription = await tx.subscription.create({
    data: {
      ...args.subscriptionSeed,
      accountId: args.callerAccountId,
      lineageId: ctx.lineageId,
    },
  });

  // Restoration = escrow release, not a grant: the period's funding-registry
  // row already exists. Release only the custody row covering the provider-
  // verified current period; stale escrow rows release nothing.
  const escrows = await tx.lineagePeriodCustody.findMany({
    where: { lineageId: ctx.lineageId, state: CUSTODY_STATE_ESCROW },
  });
  let released = 0n;
  for (const custody of escrows) {
    const coversCurrent =
      custody.periodStart.getTime() <= args.currentPeriodStart.getTime() &&
      custody.periodEnd.getTime() > args.currentPeriodStart.getTime();
    if (coversCurrent) {
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
  await stampLineage(tx, ctx, { journalId, state: LINEAGE_STATE_LIVE });

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

/**
 * Execute or cancel pending live-tier transfers whose contest window ended.
 * An authenticated act by the old account after the pending row was created
 * (lastAuthAt, used strictly as a veto) cancels; a lineage tombstoned in the
 * meantime (owner deleted) cancels too — the claimant re-claims via
 * restoration. Runs from the deletion outbox sweep tick.
 */
export const settlePendingTransfers = async (): Promise<{
  committed: number;
  cancelled: number;
}> => {
  const due = await prisma.subscriptionTransfer.findMany({
    where: { status: "pending", contestEndsAt: { lte: new Date() } },
    take: 20,
  });
  let committed = 0;
  let cancelled = 0;
  for (const pendingRow of due) {
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const ctx = await lockLineage(tx, pendingRow.lineageId);
          const journal = await tx.subscriptionTransfer.findUnique({
            where: { id: pendingRow.id },
          });
          if (!journal || journal.status !== "pending") return "skipped";
          const lineage = await tx.subscriptionLineage.findUniqueOrThrow({
            where: { id: ctx.lineageId },
          });
          const row = await tx.subscription.findFirst({
            where: { lineageId: ctx.lineageId },
          });
          const oldAccount = journal.fromAccountId
            ? await tx.account.findUnique({
                where: { id: journal.fromAccountId },
                select: { lastAuthAt: true },
              })
            : null;
          const vetoed =
            oldAccount?.lastAuthAt !== null &&
            oldAccount?.lastAuthAt !== undefined &&
            oldAccount.lastAuthAt.getTime() > journal.createdAt.getTime();
          if (
            vetoed ||
            lineage.state === LINEAGE_STATE_TOMBSTONED ||
            lineage.liveTransferFrozenAt ||
            !row ||
            row.accountId !== journal.fromAccountId ||
            !journal.toAccountId
          ) {
            await tx.subscriptionTransfer.update({
              where: { id: journal.id },
              data: { status: "cancelled" },
            });
            return "cancelled";
          }
          await executeOwnershipMove(tx, ctx, {
            journalId: journal.id,
            kind: "transfer",
            row,
            toAccountId: journal.toAccountId,
            providerProof: journal.providerProof ?? {},
          });
          await stampLineage(tx, ctx, { journalId: journal.id });
          return "committed";
        },
        { timeout: 30_000 },
      );
      if (result === "committed") committed += 1;
      if (result === "cancelled") cancelled += 1;
    } catch (err) {
      logger.error(
        { err, transferId: pendingRow.id },
        "subscription.claim.pending_settlement_failed",
      );
    }
  }
  if (committed + cancelled > 0) {
    logger.info({ committed, cancelled }, "subscription.claim.pending_settled");
  }
  return { committed, cancelled };
};
