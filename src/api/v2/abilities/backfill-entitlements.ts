import { randomUUID } from "node:crypto";
import { Composio } from "@composio/core";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { normalizeAbilityId } from "@/api/v2/abilities/ability-id";
import {
  COMPOSIO_DERIVED_STATUS_RANK,
  toEntitlementStatus,
  type ComposioDerivedStatus,
} from "@/api/v2/abilities/entitlement-status";
import { getServedAbilityVersion } from "@/api/v2/abilities/manifests.config";
import { COMPOSIO_USER_ID_MIGRATION_KEY } from "@/api/v2/connections/migrate-user-ids";
import { COMPOSIO_API_KEY } from "@/config";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Boot-time backfill + reconciliation sweep: converge V1 connection state
 * into the entitlement tables (docs/plans/abilities-entitlements.md, data
 * model).
 *
 * Entitlements source from the UNION of two sides, because each covers rows
 * the other misses:
 *   - the Composio connected-account inventory (one candidate per
 *     (accountId, toolkit); the most usable connection determines status) —
 *     covers connected-but-never-granted accounts, which must not drop;
 *   - the distinct (ownerAccountId, toolkit) pairs over LIVE ConnectionGrant
 *     rows — covers granted-but-credential-gone accounts, backfilled as
 *     `expired` (the credential is unusable; re-running OAuth is the remedy).
 *
 * Each live grant then maps 1:1 to a ConversationAbility. The extension keeps
 * the grant's id and createdAt, so wire-visible grant ids and timestamps stay
 * stable when the V1 handlers switch to reading these tables. Ability ids are
 * normalized to their canonical lowercase form at every write; a merge step
 * folds historical case-variant entitlement rows onto the canonical id first.
 *
 * The pass is convergent/idempotent, and it doubles as the PRD's post-rollout
 * reconciliation sweep (old replicas may write legacy ConnectionGrant rows
 * while a deploy rolls out):
 *   - it creates/refreshes entitlements and extensions from current truth;
 *   - it DELETES extensions stranded by a late legacy revocation: adapter-
 *     and backfill-created extensions share their legacy grant's id, so an
 *     extension whose id matches a revoked or expired grant is exactly the
 *     carry-over of a grant that died after it was mirrored. V2-native rows
 *     have their own generated ids and are never matched, so V2-written
 *     state always survives sweeps.
 * One hard rule on top: a revoked entitlement (revokedAt set) is never
 * touched — explicit user revocation must not be resurrected by a stale
 * credential whose external deletion failed. The V1 complete adapter
 * un-revokes on an explicit reconnect instead.
 *
 * Operational trigger — the ledger is EPOCH-keyed. The RuntimeConfig marker
 * stores the epoch of the last completed pass; every boot re-runs the pass
 * until the stored epoch reaches ABILITY_ENTITLEMENTS_BACKFILL_EPOCH. To run
 * the post-rollout reconciliation sweep (or force any re-run):
 *   - code: bump ABILITY_ENTITLEMENTS_BACKFILL_EPOCH and deploy — the next
 *     boot of each environment re-runs the sweep exactly once. This is the
 *     intended "after full rollout" trigger: ship the feature at epoch N,
 *     then land an epoch N+1 bump once every replica is on the new code;
 *   - ops: delete the marker row (or lower its value) and restart a replica.
 *
 * Cutover is a SECOND marker, not the backfill marker: the pass snapshots
 * legacy grants at a point in time, and an old replica can commit a legacy
 * write after that snapshot but before (or after) the pass marker lands —
 * converged by nothing if reads flipped on the pass marker alone. So the
 * new-table read model (read-readiness.ts) requires the cutover marker,
 * which is written only by a post-drain step: LEGACY_WRITER_DRAIN_MS after
 * the pass completes (comfortably longer than any rolling deploy's
 * old-replica overlap), a DB-only sweep re-converges everything the drain
 * window let old replicas write, then records the cutover epoch. Until then
 * every reader stays on the legacy matcher, which is complete by
 * construction (old replicas write it natively, new replicas dual-write).
 * While an environment's ledgers are behind the code's epoch, the exec
 * reader likewise stays on the legacy matcher — new-table reads are served
 * only from a snapshot the sweep has confirmed complete AND drained.
 */

// Marker row in RuntimeConfig — the backfill ledger (cf. _prisma_migrations).
// The VALUE holds the completed epoch (integer as string; the historical
// value "done" reads as epoch 1).
export const ABILITY_ENTITLEMENTS_BACKFILL_KEY =
  "ability_entitlements_backfill_v1";

/**
 * Current backfill epoch. Bump to make every environment re-run the
 * reconciliation sweep on its next boot (see the module comment for when).
 * Epoch 2 = normalization + dead-grant reconciliation shipped.
 */
export const ABILITY_ENTITLEMENTS_BACKFILL_EPOCH = 2;

/** Parse a ledger value into the completed epoch (0 = never completed). */
export function backfillLedgerEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  if (value === "done") return 1;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** True when the ledger confirms the CURRENT epoch's pass has completed. */
export function isBackfillLedgerCurrent(
  value: string | null | undefined,
): boolean {
  return backfillLedgerEpoch(value) >= ABILITY_ENTITLEMENTS_BACKFILL_EPOCH;
}

// Cutover marker: written by the post-drain step (see the module comment).
// Same epoch encoding as the backfill marker; read-readiness requires BOTH
// at the current epoch before new-table-only reads are served.
export const ABILITY_ENTITLEMENTS_CUTOVER_KEY =
  "ability_entitlements_cutover_v1";

/**
 * How long after the pass completes before the cutover confirm runs. Must
 * exceed the longest old-replica overlap of a rolling deploy: any legacy
 * write an old replica lands in this window is picked up by the confirm's
 * DB-only sweep before reads flip.
 */
export const LEGACY_WRITER_DRAIN_MS = 15 * 60 * 1000;

// Short-lived lease taken BEFORE the Composio inventory fetch, so an epoch
// bump does not stampede every starting replica into the same project-wide
// external scan (the advisory lock cannot cover the fetch — it is
// transaction-scoped, and holding a transaction open across external HTTP is
// exactly what the materialize-first structure exists to avoid). Value is
// "<expiry epoch-millis>:<owner token>": the token is what makes stealing
// safe — an expired lease is stealable, the holder renews under its own
// token while scanning, and release is a CAS on the holder's token, so a
// stale original holder can never delete a thief's live lease (which would
// admit a third concurrent scan). Exported for the concurrency test.
export const BACKFILL_LEASE_KEY = "ability_entitlements_backfill_lease_v1";
const BACKFILL_LEASE_TTL_MS = 15 * 60 * 1000;
// Renew at a third of the TTL: two renewals must fail before a live scan's
// lease can expire under it.
const BACKFILL_LEASE_RENEW_MS = BACKFILL_LEASE_TTL_MS / 3;

// Arbitrary constant identifying this routine's Postgres advisory lock, so two
// instances booting at once cannot both run it. Distinct from the
// migrate-user-ids lock (728_193_641).
const ADVISORY_LOCK_KEY = 811_442_907;

// deleteMany(id IN ...) batch size for the dead-grant reconciliation step.
const DELETE_CHUNK_SIZE = 500;

/** One Composio connected account, reduced to what the backfill consumes. */
export type ConnectedAccountSummary = {
  id: string;
  userId: string;
  toolkitSlug: string;
  status: string;
};

/**
 * Project-wide connected-account inventory, following Composio's cursor
 * pagination page by page (resumable in the sense that a failed run leaves
 * the ledger unset and the next boot restarts the idempotent pass).
 */
export async function* listAllConnectedAccounts(
  client: ReturnType<Composio["getClient"]>,
): AsyncGenerator<ConnectedAccountSummary> {
  let cursor: string | null | undefined;
  do {
    const page = await client.connectedAccounts.list({
      cursor: cursor ?? null,
      limit: 100,
    });
    for (const item of page.items) {
      yield {
        id: item.id,
        // The stable owner key connections were migrated to (migrate-user-ids).
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        userId: item.user_id,
        toolkitSlug: item.toolkit.slug,
        status: item.status,
      };
    }
    cursor = page.next_cursor;
  } while (cursor);
}

export type BackfillCounts = {
  connectionsScanned: number;
  // user_id is not a known Account.id (device-keyed leftovers belong to the
  // user-id migration, which runs first; true orphans are log-only there too).
  connectionsOrphaned: number;
  // Case-variant entitlement rows folded onto the canonical lowercase id.
  entitlementsCaseMerged: number;
  entitlementsCreated: number;
  entitlementsRefreshed: number;
  entitlementsUnchanged: number;
  // Revocation tombstones are never touched (nor are their grants carried).
  entitlementsSkippedRevoked: number;
  grantsScanned: number;
  grantsSkippedRevokedEntitlement: number;
  extensionsUpserted: number;
  // Reconciliation: extensions whose shared-id legacy grant died (late
  // revocation/expiry written by an old replica) are removed.
  extensionsRemovedForDeadGrants: number;
};

type BackfillDb = Pick<
  PrismaClient,
  "account" | "connectionGrant" | "abilityEntitlement" | "conversationAbility"
>;

type EntitlementCandidate = {
  status: ComposioDerivedStatus;
  connectionId: string | null;
};

function candidateKey(accountId: string, abilityId: string): string {
  return `${accountId}\u0000${abilityId}`;
}

/**
 * Fold case-variant entitlement rows onto the canonical lowercase ability id
 * so one (account, ability) never splits across rows the lifecycle routes
 * cannot all address. Variant rows are rare (old V1-adapter writes stored the
 * toolkit as sent), so this works row by row:
 *   - no canonical row yet: rename the variant in place (id and extensions
 *     kept);
 *   - canonical row exists and is a revocation tombstone: the tombstone wins
 *     — the variant row and its extensions are deleted (never resurrect);
 *   - both live: re-parent the variant's extensions onto the canonical row
 *     (duplicate (conversation, agent) opt-ins are dropped — the canonical
 *     row's version wins), then delete the variant row.
 */
async function mergeCaseVariantEntitlements(
  db: BackfillDb,
  log: Logger,
  counts: BackfillCounts,
): Promise<void> {
  const all = await db.abilityEntitlement.findMany({
    select: { id: true, accountId: true, abilityId: true, revokedAt: true },
  });
  const variants = all.filter(
    (row) => row.abilityId !== normalizeAbilityId(row.abilityId),
  );
  for (const variant of variants) {
    const abilityId = normalizeAbilityId(variant.abilityId);
    const canonical = await db.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId: variant.accountId, abilityId },
      },
    });
    if (!canonical) {
      await db.abilityEntitlement.update({
        where: { id: variant.id },
        data: { abilityId },
      });
      counts.entitlementsCaseMerged += 1;
      continue;
    }
    if (!canonical.revokedAt) {
      const extensions = await db.conversationAbility.findMany({
        where: { entitlementId: variant.id },
        select: { id: true, conversationId: true, agentInboxId: true },
      });
      for (const extension of extensions) {
        const duplicate = await db.conversationAbility.findUnique({
          where: {
            entitlementId_conversationId_agentInboxId: {
              entitlementId: canonical.id,
              conversationId: extension.conversationId,
              agentInboxId: extension.agentInboxId,
            },
          },
          select: { id: true },
        });
        if (duplicate) continue;
        await db.conversationAbility.update({
          where: { id: extension.id },
          data: { entitlementId: canonical.id },
        });
      }
    }
    // Deleting the variant row cascades whatever extensions were not
    // re-parented (all of them when the canonical row is a tombstone).
    await db.abilityEntitlement.delete({ where: { id: variant.id } });
    counts.entitlementsCaseMerged += 1;
    log.info(
      {
        accountId: variant.accountId,
        variant: variant.abilityId,
        canonical: abilityId,
      },
      "[abilities-backfill] merged case-variant entitlement",
    );
  }
}

/** Core convergence pass. See the module comment for sources and rules. */
export async function backfillAbilityEntitlements(opts: {
  log: Logger;
  db?: BackfillDb;
  /** Injectable inventory for tests; defaults to the live Composio pager. */
  source: AsyncIterable<ConnectedAccountSummary>;
  /**
   * False for the DB-only post-drain sweep: existing entitlement rows keep
   * their status/credential ref untouched (there is no Composio inventory to
   * refresh them FROM — an empty source would otherwise read as "credential
   * gone" and downgrade live rows to expired). Creation for pairs that are
   * genuinely new still happens, with the expired fallback; the next full
   * pass reconciles their status. Default true.
   */
  refreshEntitlementStatus?: boolean;
}): Promise<BackfillCounts> {
  const { log, source } = opts;
  const db = opts.db ?? prisma;
  const refreshEntitlementStatus = opts.refreshEntitlementStatus ?? true;

  const counts: BackfillCounts = {
    connectionsScanned: 0,
    connectionsOrphaned: 0,
    entitlementsCaseMerged: 0,
    entitlementsCreated: 0,
    entitlementsRefreshed: 0,
    entitlementsUnchanged: 0,
    entitlementsSkippedRevoked: 0,
    grantsScanned: 0,
    grantsSkippedRevokedEntitlement: 0,
    extensionsUpserted: 0,
    extensionsRemovedForDeadGrants: 0,
  };

  await mergeCaseVariantEntitlements(db, log, counts);

  const accounts = await db.account.findMany({ select: { id: true } });
  const accountIds = new Set(accounts.map((a) => a.id));

  // The union of entitlement keys, populated structurally from both sources
  // (keys are opaque — never parsed back).
  const wanted = new Map<string, { accountId: string; abilityId: string }>();

  // Composio side: one candidate per (accountId, toolkit); best status wins,
  // and the best-ranked connection's id backs the entitlement.
  const candidates = new Map<string, EntitlementCandidate>();
  for await (const connection of source) {
    counts.connectionsScanned += 1;
    if (!accountIds.has(connection.userId)) {
      counts.connectionsOrphaned += 1;
      log.warn(
        {
          connection: connection.id,
          userId: connection.userId,
          toolkit: connection.toolkitSlug,
        },
        "[abilities-backfill] orphan connection: user_id is not a known account",
      );
      continue;
    }
    const abilityId = normalizeAbilityId(connection.toolkitSlug);
    const key = candidateKey(connection.userId, abilityId);
    wanted.set(key, { accountId: connection.userId, abilityId });
    const status = toEntitlementStatus(connection.status, log);
    const prev = candidates.get(key);
    if (
      !prev ||
      COMPOSIO_DERIVED_STATUS_RANK[status] <
        COMPOSIO_DERIVED_STATUS_RANK[prev.status]
    ) {
      candidates.set(key, { status, connectionId: connection.id });
    }
  }

  // Grant side: live rows only — the same predicate exec enforces. Toolkits
  // are normalized so both sides' keys coincide regardless of the casing an
  // old client sent.
  const now = new Date();
  const liveGrants = await db.connectionGrant.findMany({
    where: {
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });
  counts.grantsScanned = liveGrants.length;

  for (const grant of liveGrants) {
    const abilityId = normalizeAbilityId(grant.toolkit);
    const key = candidateKey(grant.ownerAccountId, abilityId);
    if (!wanted.has(key)) {
      wanted.set(key, { accountId: grant.ownerAccountId, abilityId });
    }
  }

  // Upsert entitlements; remember ids for the extension pass.
  const entitlementIdByKey = new Map<string, string>();
  for (const [key, { accountId, abilityId }] of wanted) {
    const candidate = candidates.get(key);
    const status: ComposioDerivedStatus = candidate?.status ?? "expired";
    const externalConnectionId = candidate?.connectionId ?? null;

    const existing = await db.abilityEntitlement.findUnique({
      where: { accountId_abilityId: { accountId, abilityId } },
    });
    if (existing?.revokedAt) {
      counts.entitlementsSkippedRevoked += 1;
      continue;
    }
    if (!existing) {
      const created = await db.abilityEntitlement.create({
        data: {
          accountId,
          abilityId,
          status,
          externalConnectionId,
          abilityVersion: getServedAbilityVersion(abilityId),
        },
      });
      entitlementIdByKey.set(key, created.id);
      counts.entitlementsCreated += 1;
      continue;
    }
    entitlementIdByKey.set(key, existing.id);
    if (
      !refreshEntitlementStatus ||
      (existing.status === status &&
        existing.externalConnectionId === externalConnectionId)
    ) {
      counts.entitlementsUnchanged += 1;
      continue;
    }
    await db.abilityEntitlement.update({
      where: { id: existing.id },
      data: { status, externalConnectionId },
    });
    counts.entitlementsRefreshed += 1;
  }

  // Each live grant maps 1:1 to an extension (granteeInboxId -> agentInboxId).
  // The extension keeps the grant's id and createdAt on create, so the V1
  // adapters serve stable ids and timestamps from the new tables.
  for (const grant of liveGrants) {
    const key = candidateKey(
      grant.ownerAccountId,
      normalizeAbilityId(grant.toolkit),
    );
    const entitlementId = entitlementIdByKey.get(key);
    if (!entitlementId) {
      counts.grantsSkippedRevokedEntitlement += 1;
      continue;
    }
    await db.conversationAbility.upsert({
      where: {
        entitlementId_conversationId_agentInboxId: {
          entitlementId,
          conversationId: grant.conversationId,
          agentInboxId: grant.granteeInboxId,
        },
      },
      create: {
        id: grant.id,
        entitlementId,
        conversationId: grant.conversationId,
        agentInboxId: grant.granteeInboxId,
        bundleIds: grant.bundleIds,
        actions: grant.actions,
        extendedByInboxId: grant.ownerInboxId,
        expiresAt: grant.expiresAt,
        createdAt: grant.createdAt,
      },
      update: {
        bundleIds: grant.bundleIds,
        actions: grant.actions,
        extendedByInboxId: grant.ownerInboxId,
        expiresAt: grant.expiresAt,
      },
    });
    counts.extensionsUpserted += 1;
  }

  // Reconcile late revocations/expiries written by old replicas: adapter- and
  // backfill-created extensions share their legacy grant's id, so an
  // extension whose id matches a dead grant is exactly the stale carry-over
  // of that grant. V2-native extensions have their own generated ids (no
  // legacy grant ever shares them) and are never matched. A live re-issue
  // clears revokedAt on the same legacy row, taking it out of this set.
  const deadGrants = await db.connectionGrant.findMany({
    where: {
      OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }],
    },
    select: { id: true },
  });
  for (let i = 0; i < deadGrants.length; i += DELETE_CHUNK_SIZE) {
    const chunk = deadGrants
      .slice(i, i + DELETE_CHUNK_SIZE)
      .map((grant) => grant.id);
    const removed = await db.conversationAbility.deleteMany({
      where: { id: { in: chunk } },
    });
    counts.extensionsRemovedForDeadGrants += removed.count;
  }

  log.info({ counts }, "[abilities-backfill] pass complete");
  return counts;
}

async function* fromMaterialized(
  items: ConnectedAccountSummary[],
): AsyncGenerator<ConnectedAccountSummary> {
  for (const item of items) {
    yield await Promise.resolve(item);
  }
}

type BackfillLease = { expiresAtMs: number; token: string };

function parseBackfillLease(value: string | undefined): BackfillLease | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  const expiresRaw = separator < 0 ? value : value.slice(0, separator);
  const expiresAtMs = Number.parseInt(expiresRaw, 10);
  return {
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
    // A token-less value (the pre-token format) parses to "" — never equal
    // to any real owner token, so it is stealable once expired and
    // releasable by no one.
    token: separator < 0 ? "" : value.slice(separator + 1),
  };
}

/**
 * Take (or renew — the call is reentrant for its own token) the inventory
 * lease. Serialized by a short advisory-locked transaction; returns false
 * when another owner holds an unexpired lease, or on lock contention.
 * Exported for the concurrency test.
 */
export async function tryAcquireBackfillLease(token: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const lockRows = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked
    `;
    if (!lockRows[0]?.locked) return false;
    const row = await tx.runtimeConfig.findUnique({
      where: { key: BACKFILL_LEASE_KEY },
    });
    const lease = parseBackfillLease(row?.value);
    const now = Date.now();
    if (lease && lease.expiresAtMs > now && lease.token !== token) {
      return false;
    }
    const value = `${now + BACKFILL_LEASE_TTL_MS}:${token}`;
    await tx.runtimeConfig.upsert({
      where: { key: BACKFILL_LEASE_KEY },
      create: { key: BACKFILL_LEASE_KEY, value },
      update: { value },
    });
    return true;
  });
}

/**
 * Release the lease ONLY if this token still owns it (advisory-lock-
 * serialized CAS): after a TTL-expiry steal, the original holder's release
 * must not delete the thief's lease. Never throws — an unreleased lease
 * expires on its own. Exported for the concurrency test.
 */
export async function releaseBackfillLease(token: string): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const lockRows = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked
      `;
      // Ownership cannot be verified without the lock; leave it to the TTL.
      if (!lockRows[0]?.locked) return;
      const row = await tx.runtimeConfig.findUnique({
        where: { key: BACKFILL_LEASE_KEY },
      });
      if (parseBackfillLease(row?.value)?.token !== token) return;
      await tx.runtimeConfig.deleteMany({
        where: { key: BACKFILL_LEASE_KEY },
      });
    });
  } catch (error) {
    logger.warn(
      { error },
      "[abilities-backfill] lease release failed; it will expire on its own",
    );
  }
}

/**
 * Boot-time guard, mirroring runComposioUserIdMigrationOnce with extra rules:
 *   - it refuses to run until the user-id migration's OWN ledger confirms
 *     completion — advisory-lock contention over there resolves the promise
 *     without doing the work, and running this pass against partially
 *     migrated Composio ownership would converge (and mark done) a wrong
 *     snapshot;
 *   - the inventory LEASE is taken before the Composio fetch, so concurrent
 *     boots (an epoch bump restarts the whole fleet) do not stampede the
 *     same project-wide external scan;
 *   - the Composio inventory is fetched BEFORE the database transaction
 *     opens, so external HTTP never runs while a DB connection and advisory
 *     lock are held;
 *   - the ledger is epoch-keyed (see the module comment): the pass re-runs on
 *     every boot until the stored epoch reaches the code's epoch, which is
 *     how the post-rollout reconciliation sweep is triggered;
 *   - completing (or finding complete) the pass schedules the post-drain
 *     cutover confirm, which is what actually flips new-table-only reads.
 * Never throws — a failure leaves the ledger unset so the next boot retries.
 */
export async function runAbilityEntitlementsBackfillOnce() {
  if (!COMPOSIO_API_KEY) return;

  try {
    const migration = await prisma.runtimeConfig.findUnique({
      where: { key: COMPOSIO_USER_ID_MIGRATION_KEY },
    });
    if (migration?.value !== "done") {
      logger.info(
        "[abilities-backfill] user-id migration not confirmed done; deferring to a later boot",
      );
      return;
    }

    const existing = await prisma.runtimeConfig.findUnique({
      where: { key: ABILITY_ENTITLEMENTS_BACKFILL_KEY },
    });
    if (existing && isBackfillLedgerCurrent(existing.value)) {
      // Pass already done; make sure the cutover confirm still happens (the
      // replica that ran the pass may have died before its drain timer).
      scheduleEntitlementCutoverConfirm(existing.updatedAt);
      return;
    }

    const leaseToken = randomUUID();
    if (!(await tryAcquireBackfillLease(leaseToken))) {
      logger.info(
        "[abilities-backfill] inventory lease held by another instance; skipping",
      );
      return;
    }

    let completed: boolean;
    try {
      const composio = new Composio({
        apiKey: COMPOSIO_API_KEY,
        allowTracking: false,
      });

      // Materialize the full inventory outside the transaction: the DB
      // transaction below must never wait on Composio HTTP. The lease is
      // renewed while the scan runs; losing it (a peer stole an expired
      // lease) aborts this attempt — the thief is doing the same work.
      const inventory: ConnectedAccountSummary[] = [];
      let leaseRenewedAt = Date.now();
      for await (const connection of listAllConnectedAccounts(
        composio.getClient(),
      )) {
        inventory.push(connection);
        if (Date.now() - leaseRenewedAt >= BACKFILL_LEASE_RENEW_MS) {
          if (!(await tryAcquireBackfillLease(leaseToken))) {
            logger.warn(
              "[abilities-backfill] inventory lease lost mid-scan; aborting this attempt",
            );
            return;
          }
          leaseRenewedAt = Date.now();
        }
      }

      completed = await prisma.$transaction(
        async (tx): Promise<boolean> => {
          const lockRows = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked
          `;
          if (!lockRows[0]?.locked) {
            logger.info(
              "[abilities-backfill] advisory lock held by another instance; skipping",
            );
            return false;
          }

          // Re-check inside the lock in case a peer finished while we waited.
          const inside = await tx.runtimeConfig.findUnique({
            where: { key: ABILITY_ENTITLEMENTS_BACKFILL_KEY },
          });
          if (isBackfillLedgerCurrent(inside?.value)) return true;

          const counts = await backfillAbilityEntitlements({
            log: logger,
            db: tx,
            source: fromMaterialized(inventory),
          });
          const value = String(ABILITY_ENTITLEMENTS_BACKFILL_EPOCH);
          await tx.runtimeConfig.upsert({
            where: { key: ABILITY_ENTITLEMENTS_BACKFILL_KEY },
            create: { key: ABILITY_ENTITLEMENTS_BACKFILL_KEY, value },
            update: { value },
          });
          logger.info(
            { counts, epoch: ABILITY_ENTITLEMENTS_BACKFILL_EPOCH },
            "[abilities-backfill] pass completed and marked; cutover confirm follows the drain window",
          );
          return true;
        },
        // The pass is DB-only (inventory pre-fetched) but may touch many rows;
        // keep headroom over the 5s interactive-tx default.
        { timeout: 10 * 60 * 1000, maxWait: 15_000 },
      );
    } finally {
      await releaseBackfillLease(leaseToken);
    }

    if (completed) {
      scheduleEntitlementCutoverConfirm(new Date());
    }
  } catch (error) {
    logger.error(
      { error },
      "[abilities-backfill] run failed; will retry on next boot",
    );
  }
}

/**
 * Schedule the post-drain cutover confirm relative to when the pass
 * completed. The timer is unref'd (never keeps the process alive) and the
 * confirm never throws; a replica dying before its timer fires is covered by
 * the next boot re-scheduling from the marker row's own updatedAt.
 */
function scheduleEntitlementCutoverConfirm(passCompletedAt: Date): void {
  const waitMs =
    passCompletedAt.getTime() + LEGACY_WRITER_DRAIN_MS - Date.now();
  if (waitMs <= 0) {
    void runEntitlementCutoverConfirmOnce();
    return;
  }
  const timer = setTimeout(() => {
    void runEntitlementCutoverConfirmOnce();
  }, waitMs);
  timer.unref();
}

/**
 * The post-drain step that actually flips new-table-only reads (see the
 * module comment): once the drain window has passed, a DB-only sweep
 * (extension convergence + dead-grant reconciliation + case merge, no
 * entitlement-status refresh) converges whatever legacy writes old replicas
 * landed after the pass snapshot, then the cutover marker records the epoch.
 * Guarded like the pass itself: advisory lock + marker re-check; never
 * throws.
 */
export async function runEntitlementCutoverConfirmOnce() {
  try {
    const backfill = await prisma.runtimeConfig.findUnique({
      where: { key: ABILITY_ENTITLEMENTS_BACKFILL_KEY },
    });
    if (!isBackfillLedgerCurrent(backfill?.value)) return;
    const cutover = await prisma.runtimeConfig.findUnique({
      where: { key: ABILITY_ENTITLEMENTS_CUTOVER_KEY },
    });
    if (isBackfillLedgerCurrent(cutover?.value)) return;

    await prisma.$transaction(
      async (tx) => {
        const lockRows = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked
        `;
        if (!lockRows[0]?.locked) {
          logger.info(
            "[abilities-backfill] cutover confirm: advisory lock held by another instance; skipping",
          );
          return;
        }
        const inside = await tx.runtimeConfig.findUnique({
          where: { key: ABILITY_ENTITLEMENTS_CUTOVER_KEY },
        });
        if (isBackfillLedgerCurrent(inside?.value)) return;

        const counts = await backfillAbilityEntitlements({
          log: logger,
          db: tx,
          source: fromMaterialized([]),
          refreshEntitlementStatus: false,
        });
        const value = String(ABILITY_ENTITLEMENTS_BACKFILL_EPOCH);
        await tx.runtimeConfig.upsert({
          where: { key: ABILITY_ENTITLEMENTS_CUTOVER_KEY },
          create: { key: ABILITY_ENTITLEMENTS_CUTOVER_KEY, value },
          update: { value },
        });
        logger.info(
          { counts, epoch: ABILITY_ENTITLEMENTS_BACKFILL_EPOCH },
          "[abilities-backfill] cutover confirmed — new-table reads enabled",
        );
      },
      { timeout: 10 * 60 * 1000, maxWait: 15_000 },
    );
  } catch (error) {
    logger.error(
      { error },
      "[abilities-backfill] cutover confirm failed; will retry on next boot",
    );
  }
}
