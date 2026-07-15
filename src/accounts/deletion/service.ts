import { BillingProvider, type Prisma } from "@prisma/client";
import { barIdentityWithTx } from "@/accounts/deletion/barrier";
import { hashAccountRef } from "@/accounts/deletion/identity-hash";
import { deleteWalletForAccountWithTx } from "@/payments/ledger";
import { forfeitSubscriptionPeriod } from "@/subscriptions/grants";
import { isEntitledSubscriptionStatus } from "@/subscriptions/status";
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
export const deleteAccount = async (args: {
  accountId: string;
  operationId: string;
}): Promise<DeletionOutcome | null> => {
  const { accountId, operationId } = args;
  const accountRef = hashAccountRef(accountId);

  return prisma.$transaction(
    async (tx) => {
      // Parent-row lock: the serialization point for every concurrent
      // account-linked writer. Must be the first statement — the sweep
      // below relies on each subsequent statement taking a fresh snapshot
      // after this lock is held.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Account" WHERE id = ${accountId}::uuid FOR UPDATE
      `;
      if (locked.length === 0) return null;

      // Snapshots (before the rows that identify the targets are deleted).
      const authMethods = await tx.authMethod.findMany({
        where: { accountId },
        select: { type: true, externalKey: true },
      });
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

      // Money bookkeeping before the wallet goes: forfeit the unused portion
      // of any entitled period (idempotent, bounded, never touches
      // non-subscription credits), then remove the ledger + wallet through
      // the payments module so the single-writer law holds.
      for (const subscription of subscriptions) {
        if (isEntitledSubscriptionStatus(subscription.status)) {
          await forfeitSubscriptionPeriod(tx, { subscription });
        }
      }

      // Billing: receipts go, subscription rows become provider-key
      // tombstones (unique per (provider, key); skipDuplicates makes a
      // replayed teardown converge).
      await tx.billingReceipt.deleteMany({
        where: { subscription: { accountId } },
      });
      const tombstoneRows: Prisma.SubscriptionTombstoneCreateManyInput[] = [];
      for (const subscription of subscriptions) {
        const keys =
          subscription.provider === BillingProvider.apple
            ? [subscription.originalTransactionId]
            : [subscription.purchaseToken, subscription.linkedPurchaseToken];
        for (const key of keys) {
          if (key) {
            tombstoneRows.push({
              provider: subscription.provider,
              providerKey: key,
              accountRef,
            });
          }
        }
      }
      if (tombstoneRows.length > 0) {
        await tx.subscriptionTombstone.createMany({
          data: tombstoneRows,
          skipDuplicates: true,
        });
      }
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
