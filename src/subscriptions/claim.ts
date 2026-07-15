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
import { withDeadlockRetry } from "@/utils/deadlock-retry";
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
  /** Exact funding-event key of the provider-verified current period
   *  (apple_txn_<latest transactionId> / play_order_<latestOrderId>).
   *  Restoration releases only this event's escrow. */
  providerPeriodKey: string;
  /** Fresh Subscription row fields for the restoration path. */
  subscriptionSeed: ClaimSubscriptionSeed;
  providerProof: Prisma.InputJsonValue;
}): Promise<ClaimExecutionResult> => {
  const { callerAccountId, lineageId } = args;

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
            lastTransfer.undoDeadlineAt !== null &&
            lastTransfer.undoDeadlineAt.getTime() > Date.now()
              ? lastTransfer
              : null;

          if (undoTarget) {
            if (lineage.liveTransferFrozenAt) {
              return { kind: "rejected" as const, reason: "transfer_frozen" };
            }
            if (undoTarget.undoneByTransferId !== null) {
              // The one-shot undo for this transfer was already spent.
              return { kind: "rejected" as const, reason: "undo_consumed" };
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
          return {
            kind: "transferred" as const,
            subscription: updated,
            conserved,
          };
        },
        { timeout: 30_000 },
      ),
    { label: "execute_claim" },
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
  // Lock order rule 3: the subscription row, explicitly, before any wallet
  // lock (custody ops take wallets, rule 4). Updating the row only after
  // the wallet moves would acquire rule-3 after rule-4.
  await tx.$queryRaw`
    SELECT id FROM "Subscription" WHERE id = ${args.row.id}::uuid FOR UPDATE
  `;
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
    return { kind: "rejected", reason: "pending_contest" };
  }

  // Restoration = escrow release, not a grant: the period's funding-registry
  // row already exists. Release ONLY the escrow row for the provider-verified
  // current funding event, selected by its exact provider period key
  // (apple_txn_<latest tx> / play_order_<latestOrderId>) — never by window
  // arithmetic: Google reports the lifetime startTime as the period start,
  // so an old period's escrow can "cover" that timestamp while the current
  // period's escrow does not. The window fallback applies only to custody
  // bootstrapped from pre-lineage periods (legacy_ keys, which no provider
  // event can name). Stale escrow rows release nothing and past ones are
  // exhausted.
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
 * Execution-time provider recheck for pending transfers. The proof stored at
 * claim time is up to CLAIM_CONTEST_WINDOW_HOURS old by settlement; the
 * subscription may have been refunded/revoked in the window, and webhook
 * compensation alone cannot close missing or delayed provider events. The
 * check asserts entitled-NOW only (not latest-transaction match — a natural
 * renewal inside the window is not theft). "unknown" (provider unreachable)
 * skips the row this tick rather than cancelling.
 */
export type SettlementEntitlementChecker = (
  providerProof: Prisma.JsonValue | null,
) => Promise<"entitled" | "not_entitled" | "unknown">;

const ENTITLED_APPLE_STATUSES = new Set([1, 4]);

const defaultEntitlementChecker: SettlementEntitlementChecker = async (
  providerProof,
) => {
  const proof =
    providerProof && typeof providerProof === "object"
      ? (providerProof as Record<string, unknown>)
      : {};
  try {
    const otx = proof.originalTransactionId;
    if (typeof otx === "string" && otx.length > 0) {
      const { getSubscriptionStatuses } =
        await import("@/subscriptions/apple-server-api");
      const statuses = await getSubscriptionStatuses(otx);
      for (const group of statuses.data ?? []) {
        for (const item of group.lastTransactions ?? []) {
          if (
            item.originalTransactionId === otx &&
            item.status !== undefined &&
            ENTITLED_APPLE_STATUSES.has(item.status)
          ) {
            return "entitled";
          }
        }
      }
      return "not_entitled";
    }
    const purchaseToken = proof.purchaseToken;
    if (typeof purchaseToken === "string" && purchaseToken.length > 0) {
      const { fetchSubscriptionPurchaseV2 } =
        await import("@/subscriptions/google-play/play-api");
      const { deriveStatusFromPurchase } =
        await import("@/subscriptions/google-play/status");
      const purchase = await fetchSubscriptionPurchaseV2(purchaseToken);
      const status = deriveStatusFromPurchase(purchase);
      const entitled =
        status === "active" || status === "grace" || status === "trial";
      return entitled ? "entitled" : "not_entitled";
    }
    // No usable proof identity: fail closed to a veto-style cancel.
    return "not_entitled";
  } catch (err) {
    logger.warn({ err }, "subscription.claim.settlement_recheck_failed");
    return "unknown";
  }
};

let settlementEntitlementChecker: SettlementEntitlementChecker | null = null;

/** Test seam: inject an entitlement checker; null restores the default. */
export const __setSettlementEntitlementCheckerForTests = (
  checker: SettlementEntitlementChecker | null,
): void => {
  settlementEntitlementChecker = checker;
};

/**
 * Execute or cancel pending live-tier transfers whose contest window ended.
 * An authenticated act by the old account after the pending row was created
 * (lastAuthAt, used strictly as a veto, read under the Account row lock so a
 * concurrent stamp cannot slip past the read) cancels; so does a lineage
 * tombstoned in the meantime (owner deleted — the claimant re-claims via
 * restoration) and a provider that no longer reports the subscription
 * entitled. A null lastAuthAt is treated as a veto (defensive: post-backfill
 * it can only mean an account whose activity we cannot reason about). Runs
 * from the deletion outbox sweep tick.
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
      // Provider recheck runs outside the transaction (third-party latency
      // must not hold locks); the fetch-to-commit TOCTOU residual is the
      // same one accepted for the claim path, compensated by webhooks.
      const checker = settlementEntitlementChecker ?? defaultEntitlementChecker;
      const entitlement = await checker(pendingRow.providerProof ?? null);
      if (entitlement === "unknown") {
        logger.warn(
          { transferId: pendingRow.id },
          "subscription.claim.settlement_deferred_provider_unreachable",
        );
        continue;
      }
      const result = await withDeadlockRetry(
        () =>
          prisma.$transaction(
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
              // Lock order rule 2: both accounts, sorted, FOR UPDATE — the
              // veto read below must serialize against a concurrent
              // lastAuthAt stamp, and the strong lock must be taken in
              // sorted order to stay deadlock-free across settlements.
              const accountIds = [journal.fromAccountId, journal.toAccountId]
                .filter((id): id is string => id !== null)
                .sort();
              const lockedAccounts = new Map<string, Date | null>();
              for (const accountId of accountIds) {
                const rows = await tx.$queryRaw<
                  Array<{ id: string; lastAuthAt: Date | null }>
                >`
                  SELECT id, "lastAuthAt" FROM "Account"
                  WHERE id = ${accountId}::uuid FOR UPDATE
                `;
                if (rows.length > 0) {
                  lockedAccounts.set(rows[0].id, rows[0].lastAuthAt);
                }
              }
              const oldLastAuthAt = journal.fromAccountId
                ? (lockedAccounts.get(journal.fromAccountId) ?? null)
                : null;
              const vetoed =
                oldLastAuthAt === null ||
                oldLastAuthAt.getTime() > journal.createdAt.getTime();
              if (
                vetoed ||
                entitlement === "not_entitled" ||
                lineage.state === LINEAGE_STATE_TOMBSTONED ||
                lineage.liveTransferFrozenAt ||
                !row ||
                row.accountId !== journal.fromAccountId ||
                !journal.toAccountId ||
                !lockedAccounts.has(journal.toAccountId)
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
          ),
        { label: "settle_pending_transfer" },
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
