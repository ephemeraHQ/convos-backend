import { Composio } from "@composio/core";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import {
  COMPOSIO_DERIVED_STATUS_RANK,
  toEntitlementStatus,
  type ComposioDerivedStatus,
} from "@/api/v2/abilities/entitlement-status";
import { getServedAbilityVersion } from "@/api/v2/abilities/manifests.config";
import { COMPOSIO_API_KEY } from "@/config";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Boot-time backfill: converge V1 connection state into the entitlement
 * tables (docs/plans/abilities-entitlements.md, data model).
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
 * stable when the V1 handlers switch to reading these tables.
 *
 * The pass is convergent/idempotent: re-running refreshes status and
 * externalConnectionId from Composio and re-upserts extensions, so it doubles
 * as the post-rollout reconciliation sweep (old replicas may write legacy
 * ConnectionGrant rows while a deploy rolls out). Two hard rules:
 *   - a revoked entitlement (revokedAt set) is never touched: explicit user
 *     revocation must not be resurrected by a stale credential whose external
 *     deletion failed. The V1 complete adapter un-revokes on an explicit
 *     reconnect instead;
 *   - the pass only creates and refreshes — it never deletes rows, so state
 *     written by the V2 endpoints between sweeps is preserved.
 *
 * To force a reconciliation re-run: delete the RuntimeConfig marker row (ops)
 * or bump the key suffix below (code); the next boot re-runs the pass.
 */

// Marker row in RuntimeConfig — the backfill ledger (cf. _prisma_migrations).
export const ABILITY_ENTITLEMENTS_BACKFILL_KEY =
  "ability_entitlements_backfill_v1";

// Arbitrary constant identifying this routine's Postgres advisory lock, so two
// instances booting at once cannot both run it. Distinct from the
// migrate-user-ids lock (728_193_641).
const ADVISORY_LOCK_KEY = 811_442_907;

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
  entitlementsCreated: number;
  entitlementsRefreshed: number;
  entitlementsUnchanged: number;
  // Revocation tombstones are never touched (nor are their grants carried).
  entitlementsSkippedRevoked: number;
  grantsScanned: number;
  grantsSkippedRevokedEntitlement: number;
  extensionsUpserted: number;
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

/** Core convergence pass. See the module comment for sources and rules. */
export async function backfillAbilityEntitlements(opts: {
  log: Logger;
  db?: BackfillDb;
  /** Injectable inventory for tests; defaults to the live Composio pager. */
  source: AsyncIterable<ConnectedAccountSummary>;
}): Promise<BackfillCounts> {
  const { log, source } = opts;
  const db = opts.db ?? prisma;

  const counts: BackfillCounts = {
    connectionsScanned: 0,
    connectionsOrphaned: 0,
    entitlementsCreated: 0,
    entitlementsRefreshed: 0,
    entitlementsUnchanged: 0,
    entitlementsSkippedRevoked: 0,
    grantsScanned: 0,
    grantsSkippedRevokedEntitlement: 0,
    extensionsUpserted: 0,
  };

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
    const abilityId = connection.toolkitSlug.toLowerCase();
    const key = candidateKey(connection.userId, abilityId);
    wanted.set(key, { accountId: connection.userId, abilityId });
    const status = toEntitlementStatus(connection.status);
    const prev = candidates.get(key);
    if (
      !prev ||
      COMPOSIO_DERIVED_STATUS_RANK[status] <
        COMPOSIO_DERIVED_STATUS_RANK[prev.status]
    ) {
      candidates.set(key, { status, connectionId: connection.id });
    }
  }

  // Grant side: live rows only — the same predicate exec enforces.
  const now = new Date();
  const liveGrants = await db.connectionGrant.findMany({
    where: {
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });
  counts.grantsScanned = liveGrants.length;

  // Grant toolkits are keyed as stored (the V1 adapter writes them as the
  // client sent them; in practice the lowercase Composio slug, which makes
  // both sides' keys coincide).
  for (const grant of liveGrants) {
    const key = candidateKey(grant.ownerAccountId, grant.toolkit);
    if (!wanted.has(key)) {
      wanted.set(key, {
        accountId: grant.ownerAccountId,
        abilityId: grant.toolkit,
      });
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
      existing.status === status &&
      existing.externalConnectionId === externalConnectionId
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
    const key = candidateKey(grant.ownerAccountId, grant.toolkit);
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

  log.info({ counts }, "[abilities-backfill] pass complete");
  return counts;
}

/**
 * Boot-time guard, mirroring runComposioUserIdMigrationOnce: short-circuits on
 * the ledger marker, takes a transaction-scoped advisory lock so concurrent
 * replicas cannot both run, records the marker on success, and never throws —
 * a failure leaves the marker unset so the next boot retries. Runs after the
 * user-id migration (see src/index.ts), which re-keys connections to
 * accountIds this pass depends on.
 */
export async function runAbilityEntitlementsBackfillOnce() {
  if (!COMPOSIO_API_KEY) return;

  try {
    const existing = await prisma.runtimeConfig.findUnique({
      where: { key: ABILITY_ENTITLEMENTS_BACKFILL_KEY },
    });
    if (existing?.value === "done") return;

    const composio = new Composio({
      apiKey: COMPOSIO_API_KEY,
      allowTracking: false,
    });

    await prisma.$transaction(
      async (tx) => {
        const lockRows = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked
        `;
        if (!lockRows[0]?.locked) {
          logger.info(
            "[abilities-backfill] advisory lock held by another instance; skipping",
          );
          return;
        }

        // Re-check inside the lock in case a peer finished while we waited.
        const inside = await tx.runtimeConfig.findUnique({
          where: { key: ABILITY_ENTITLEMENTS_BACKFILL_KEY },
        });
        if (inside?.value === "done") return;

        const counts = await backfillAbilityEntitlements({
          log: logger,
          db: tx,
          source: listAllConnectedAccounts(composio.getClient()),
        });
        await tx.runtimeConfig.upsert({
          where: { key: ABILITY_ENTITLEMENTS_BACKFILL_KEY },
          create: { key: ABILITY_ENTITLEMENTS_BACKFILL_KEY, value: "done" },
          update: { value: "done" },
        });
        logger.info(
          { counts },
          "[abilities-backfill] completed and marked done",
        );
      },
      // External Composio HTTP calls run inside the lock; give the pass
      // headroom rather than the 5s interactive-tx default.
      { timeout: 10 * 60 * 1000, maxWait: 15_000 },
    );
  } catch (error) {
    logger.error(
      { error },
      "[abilities-backfill] run failed; will retry on next boot",
    );
  }
}
