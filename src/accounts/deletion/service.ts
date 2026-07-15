import { randomUUID } from "node:crypto";
import { BillingProvider, type Prisma } from "@prisma/client";
import { barIdentityWithTx } from "@/accounts/deletion/barrier";
import {
  hashAccountRef,
  hashDeletedIdentity,
} from "@/accounts/deletion/identity-hash";
import { lockIdentityForMintOrDeletion } from "@/accounts/repository";
import { deleteWalletForAccountWithTx } from "@/payments/ledger";
import {
  bootstrapLegacyCustody,
  CUSTODY_STATE_HELD,
  escrowCustody,
  findCustodyCovering,
} from "@/subscriptions/custody";
import {
  LINEAGE_STATE_TOMBSTONED,
  lockLineage,
  resolveLineageId,
  resolveOrCreateLineageForKeys,
} from "@/subscriptions/lineage";
import { isRetryableTxConflict } from "@/utils/deadlock-retry";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Account deletion teardown. One transaction that removes every row
 * traceable to the account, erects the deletion barrier, writes the billing
 * tombstones, snapshots the external-purge outbox, and records the durable
 * DeletionRecord — children before parents, Account last.
 *
 * Lock protocol: the first statement locks the Account row FOR UPDATE.
 * Every concurrent writer that attaches account-linked state takes its own
 * Account lock (FOR KEY SHARE via requireLiveAccount, or implicitly through
 * an FK check) as its first locking statement, so writers serialize against
 * this teardown — never against each other — and the global Account-first
 * ordering keeps the two sides deadlock-free.
 */

/** Published completion window for the asynchronous external purges. */
export const PURGE_WINDOW_HOURS = 24;

/**
 * Sentinel accountId for the retained AdminAudit deletion entry: the real id
 * must not survive deletion and the column is a plain UUID scalar, so every
 * deletion entry shares this sentinel and carries the keyed accountRef in
 * `reason` as the operator-facing correlation handle. Pre-existing AdminAudit
 * rows for the account are retained as-is under the ops-audit carve-out.
 */
const DELETION_AUDIT_ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

/** Deletion-task kinds drained by the outbox worker. */
export const DELETION_TASK_KINDS = [
  "s3_object",
  "notification_installation",
  "composio_user",
  "posthog_person",
] as const;
export type DeletionTaskKind = (typeof DELETION_TASK_KINDS)[number];

export type DeletionOutcome = {
  operationId: string;
  deletedAt: Date;
  purgeWindowHours: number;
};

const attachmentKeysFromInputs = (inputs: Prisma.JsonValue): string[] => {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    return [];
  }
  const attachments = (inputs as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return [];
  const keys: string[] = [];
  for (const attachment of attachments) {
    if (
      attachment &&
      typeof attachment === "object" &&
      typeof (attachment as { objectKey?: unknown }).objectKey === "string"
    ) {
      keys.push((attachment as { objectKey: string }).objectKey);
    }
  }
  return keys;
};

/**
 * Run the deletion teardown for a live account. Returns null when the
 * Account row does not exist (already deleted): the caller then resolves the
 * stored DeletionRecord instead.
 */
/**
 * Resolve (creating when needed) the lineage ids for every subscription the
 * account currently holds. Runs unlocked, outside the teardown transaction —
 * the transaction re-reads under lock and restarts if the set changed.
 */
const resolveAccountLineageIds = async (
  accountId: string,
): Promise<string[]> => {
  const subscriptions = await prisma.subscription.findMany({
    where: { accountId },
  });
  const ids = new Set<string>();
  for (const subscription of subscriptions) {
    if (subscription.lineageId) {
      ids.add(subscription.lineageId);
      continue;
    }
    const key =
      subscription.provider === BillingProvider.apple
        ? subscription.originalTransactionId
        : subscription.purchaseToken;
    if (!key) continue;
    ids.add(
      await resolveOrCreateLineageForKeys({
        provider: subscription.provider,
        key,
        linkedPurchaseToken: subscription.linkedPurchaseToken,
      }),
    );
  }
  return [...ids].sort();
};

const TEARDOWN_RESTART_LIMIT = 3;

class TeardownRestart extends Error {}

export const deleteAccount = async (args: {
  accountId: string;
  operationId: string;
}): Promise<DeletionOutcome | null> => {
  const { operationId } = args;

  // Restart discipline: a restart is a full rollback plus a fresh
  // transaction — never a new lower-sorted lock acquired mid-flight. A
  // Postgres deadlock/serialization failure (40P01/40001) restarts the same
  // way: the teardown is idempotent under its operationId.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runDeleteAccountTransaction(args);
    } catch (err) {
      const restartable =
        err instanceof TeardownRestart || isRetryableTxConflict(err);
      if (restartable && attempt < TEARDOWN_RESTART_LIMIT) {
        logger.warn(
          { operationId, attempt },
          "account.delete.teardown_restarted",
        );
        continue;
      }
      throw err;
    }
  }
};

const runDeleteAccountTransaction = async (args: {
  accountId: string;
  operationId: string;
}): Promise<DeletionOutcome | null> => {
  const { accountId, operationId } = args;
  const accountRef = hashAccountRef(accountId);

  // Lineages first (lock-order rule 1), resolved before the transaction.
  const lineageIds = await resolveAccountLineageIds(accountId);

  return prisma.$transaction(
    async (tx) => {
      // Lock order: every lineage the account's subscriptions belong to
      // (sorted), then the Account row FOR UPDATE — the serialization point
      // for every concurrent account-linked writer. The sweep below relies
      // on each subsequent statement taking a fresh snapshot after these
      // locks are held.
      const lineageCtxs = new Map<
        string,
        Awaited<ReturnType<typeof lockLineage>>
      >();
      for (const lineageId of lineageIds) {
        lineageCtxs.set(lineageId, await lockLineage(tx, lineageId));
      }
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Account" WHERE id = ${accountId}::uuid FOR UPDATE
      `;
      if (locked.length === 0) return null;

      // Snapshots (before the rows that identify the targets are deleted).
      const authMethods = await tx.authMethod.findMany({
        where: { accountId },
        select: { type: true, externalKey: true },
      });
      // Serialize against token mint per identity (the same advisory lock
      // the mint upsert takes): a mint holding the lock finishes first and
      // its rows are swept below; a mint arriving later blocks here and then
      // sees the committed barrier inside its own transaction. Sorted for a
      // deterministic acquisition order.
      const identityHashes = authMethods
        .map((method) => hashDeletedIdentity(method.type, method.externalKey))
        .sort();
      for (const identityHash of identityHashes) {
        await lockIdentityForMintOrDeletion(tx, identityHash);
      }
      const subscriptions = await tx.subscription.findMany({
        where: { accountId },
      });
      const clientIdentifiers = await tx.clientIdentifier.findMany({
        where: { accountId },
        select: { id: true },
      });
      const templates = await tx.agentTemplate.findMany({
        where: { ownerAccountId: accountId },
        select: { avatarUrl: true },
      });
      const generations = await tx.agentTemplateGeneration.findMany({
        where: { ownerAccountId: accountId },
        select: { inputs: true },
      });

      // Money bookkeeping before the wallet goes: escrow the conservative
      // remainder of each held custody period (the tombstone snapshot,
      // released to a future claimant), journal the move, and flip the
      // lineage to tombstoned. Periods funded before the lineage tables get
      // a lazy custody bootstrap; never-funded subscriptions escrow nothing.
      // A subscription whose lineage is not in our locked set (attached
      // between the unlocked resolve and the locks) restarts the teardown
      // with the fresh set.
      for (const subscription of subscriptions) {
        const subscriptionLineageId =
          subscription.lineageId ??
          (await resolveLineageId(
            tx,
            subscription.provider,
            subscription.provider === BillingProvider.apple
              ? [subscription.originalTransactionId]
              : [subscription.purchaseToken, subscription.linkedPurchaseToken],
          ));
        if (!subscriptionLineageId) continue;
        const ctx = lineageCtxs.get(subscriptionLineageId);
        if (!ctx) {
          throw new TeardownRestart();
        }
        const custody =
          (await findCustodyCovering(tx, ctx, new Date(), [
            CUSTODY_STATE_HELD,
          ])) ??
          (await bootstrapLegacyCustody(tx, ctx, {
            subscriptionId: subscription.id,
            ownerAccountId: accountId,
            periodStart: subscription.currentPeriodStart,
            periodEnd: subscription.currentPeriodEnd,
          }));
        if (custody && custody.state === CUSTODY_STATE_HELD) {
          const journalId = randomUUID();
          const escrowed = await escrowCustody(tx, ctx, {
            custody,
            journalId,
          });
          await tx.subscriptionTransfer.create({
            data: {
              id: journalId,
              lineageId: ctx.lineageId,
              kind: "escrow",
              status: "committed",
              fromAccountId: accountId,
              conservedCredits: escrowed,
            },
          });
        }
        await tx.subscriptionLineage.update({
          where: { id: ctx.lineageId },
          data: {
            state: LINEAGE_STATE_TOMBSTONED,
            tombstonedAt: new Date(),
            deletedAccountRef: accountRef,
          },
        });
      }

      // Billing: receipts and subscription rows go; the tombstoned lineage
      // (plus escrow custody) is what survives.
      await tx.billingReceipt.deleteMany({
        where: { subscription: { accountId } },
      });
      await tx.subscription.deleteMany({ where: { accountId } });

      await deleteWalletForAccountWithTx(tx, accountId);

      // Builder content. Generations first (they reference templates), then
      // templates; forks of the deleted templates and other accounts'
      // generations referencing them are unlinked by ON DELETE SET NULL.
      await tx.agentTemplateGeneration.deleteMany({
        where: { ownerAccountId: accountId },
      });
      await tx.agentTemplate.deleteMany({
        where: { ownerAccountId: accountId },
      });

      // Devices hold push tokens: delete outright (cascades their
      // ClientIdentifiers), then sweep ClientIdentifier by accountId
      // directly — stale rows whose device re-registered under another
      // account are unreachable through the device cascade.
      await tx.deviceRegistration.deleteMany({ where: { accountId } });
      await tx.clientIdentifier.deleteMany({ where: { accountId } });

      // ConnectionGrant rows cascade with the Account delete below; the
      // remote Composio purge is enumerated post-commit by the outbox
      // worker via list-for-user, not derived from grants.

      // Auth identity: delete the methods and erect the permanent barrier
      // in the same transaction.
      for (const method of authMethods) {
        await barIdentityWithTx(tx, {
          type: method.type,
          externalKey: method.externalKey,
        });
      }
      await tx.authMethod.deleteMany({ where: { accountId } });

      // Durable deletion record (idempotent on operationId) + outbox.
      const record = await tx.deletionRecord.upsert({
        where: { operationId },
        update: {},
        create: { operationId, accountRef, status: "purging" },
      });

      const tasks: Prisma.DeletionTaskCreateManyInput[] = [];
      for (const clientIdentifier of clientIdentifiers) {
        tasks.push({
          operationId,
          kind: "notification_installation",
          payload: { installationId: clientIdentifier.id },
        });
      }
      for (const template of templates) {
        if (template.avatarUrl) {
          tasks.push({
            operationId,
            kind: "s3_object",
            payload: { target: "public", url: template.avatarUrl },
          });
        }
      }
      for (const generation of generations) {
        for (const objectKey of attachmentKeysFromInputs(generation.inputs)) {
          tasks.push({
            operationId,
            kind: "s3_object",
            payload: { target: "private", key: objectKey },
          });
        }
      }
      // The outbox necessarily retains the raw account id until drained
      // (Composio and PostHog key their remote state by it); the record and
      // tasks are themselves retained-class data with a bounded lifetime.
      tasks.push({
        operationId,
        kind: "composio_user",
        payload: { accountId },
      });
      tasks.push({
        operationId,
        kind: "posthog_person",
        payload: { distinctId: accountId },
      });
      if (tasks.length > 0) {
        await tx.deletionTask.createMany({ data: tasks });
      }

      // Retained ops-audit entry: sentinel account id, keyed ref in reason.
      await tx.adminAudit.upsert({
        where: {
          accountId_idempotencyKey: {
            accountId: DELETION_AUDIT_ACCOUNT_ID,
            idempotencyKey: `account_deletion_${operationId}`,
          },
        },
        update: {},
        create: {
          accountId: DELETION_AUDIT_ACCOUNT_ID,
          actorEmail: "system:account-deletion",
          action: "account_deletion",
          deltaCredits: 0n,
          reason: `accountRef=${accountRef}`,
          idempotencyKey: `account_deletion_${operationId}`,
        },
      });

      // Root last. ConnectionGrant cascades here.
      await tx.account.delete({ where: { id: accountId } });

      return {
        operationId: record.operationId,
        deletedAt: record.requestedAt,
        purgeWindowHours: PURGE_WINDOW_HOURS,
      };
    },
    // The teardown is many statements and must never be split; give it more
    // headroom than the 5s interactive-transaction default.
    { timeout: 30_000 },
  );
};

/**
 * Stored deletion record for an already-deleted account (idempotent-retry
 * path). Resolved by the keyed account ref, so a retry with a different
 * operationId still finds the committed record and echoes the stored one.
 */
export const findDeletionRecordForAccount = async (
  accountId: string,
): Promise<DeletionOutcome | null> => {
  const record = await prisma.deletionRecord.findFirst({
    where: { accountRef: hashAccountRef(accountId) },
    orderBy: { requestedAt: "asc" },
  });
  if (!record) return null;
  return {
    operationId: record.operationId,
    deletedAt: record.requestedAt,
    purgeWindowHours: PURGE_WINDOW_HOURS,
  };
};
