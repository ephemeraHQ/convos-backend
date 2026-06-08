import { Composio } from "@composio/core";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { COMPOSIO_API_KEY } from "@/config";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * One-time data migration: move Composio connected accounts from being keyed by
 * the per-device `deviceId` to the stable account `accountId`.
 *
 * Composio's `user_id` is immutable, but a connection can be MOVED by
 * re-creating it from its existing credentials under a new `user_id`, then
 * deleting the original — this carries OAuth tokens over so users do NOT have to
 * re-authenticate. The move is retrieve -> create(under accountId) -> delete.
 *
 * Classification is by DB membership (NOT UUID shape, since both deviceId and
 * accountId can be UUIDs):
 *   - user_id is a known Account.id          -> already migrated, skip
 *   - user_id is a known DeviceRegistration  -> MOVE to that device's accountId
 *   - neither                                -> orphan, log only (never touched)
 *
 * The function is convergent/idempotent: a second pass finds migrated
 * connections keyed by accountId (skipped) and moved originals deleted, so it is
 * a no-op. {@link runComposioUserIdMigrationOnce} wraps it with a once-per-env
 * guard so it runs automatically on deploy, exactly like a DB migration.
 */

// Marker row in RuntimeConfig — our migration ledger (cf. _prisma_migrations).
// Bump the suffix if the migration ever needs to be re-run intentionally.
export const COMPOSIO_USER_ID_MIGRATION_KEY = "composio_user_id_migration_v1";

// Arbitrary constant identifying this migration's Postgres advisory lock, so two
// instances booting at once can't both run it (and create duplicates).
const ADVISORY_LOCK_KEY = 728_193_641;

// Credential fields whose presence means the move can actually carry auth over.
// Best-effort list spanning Composio's auth schemes (OAuth2/OAuth1, API key,
// basic, bearer, service account); presence of any one is enough. May need
// extending if Composio introduces new credential field names — a connection
// with none readable is treated as "needs re-auth" rather than silently dropped.
const SECRET_KEYS = [
  "access_token",
  "refresh_token",
  "token",
  "bearer_token",
  "api_key",
  "generic_api_key",
  "password",
  "basic_encoded",
  "private_key",
  "credentials_json",
];

export type MigrationCounts = {
  scanned: number;
  alreadyMigrated: number;
  moved: number;
  // Credentials unreadable (redacted/absent) or the legacy create endpoint is
  // retired for the auth config — the user must reconnect. Not retryable.
  needsReauth: number;
  // Transient API errors (retrieve/create/delete) — left in place, retried on
  // the next run. Distinct from needsReauth so operators can tell them apart.
  failed: number;
  orphaned: number;
  skippedNoAccount: number;
};

// Both PrismaClient and an interactive-transaction client satisfy this.
type MigrationDb = Pick<PrismaClient, "account" | "deviceRegistration">;

function presentSecretKeys(val: unknown): string[] {
  if (typeof val !== "object" || val === null) return [];
  const record = val as Record<string, unknown>;
  return SECRET_KEYS.filter((key) => {
    const value = record[key];
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * Core migration pass. With `apply: false` (the default for the CLI) it mutates
 * nothing and reports what it would do, including whether credentials are
 * actually readable (the redaction check).
 */
export async function migrateComposioConnectionsToAccountId(opts: {
  apply: boolean;
  log: Logger;
  db?: MigrationDb;
}) {
  const { apply, log } = opts;
  const db = opts.db ?? prisma;

  if (!COMPOSIO_API_KEY) {
    throw new Error("COMPOSIO_API_KEY is not set; cannot run migration.");
  }

  // 1. Build DB lookups.
  const accounts = await db.account.findMany({ select: { id: true } });
  const accountIds = new Set(accounts.map((a) => a.id));

  const devices = await db.deviceRegistration.findMany({
    select: { deviceId: true, accountId: true },
  });
  const deviceToAccount = new Map<string, string>();
  const knownDeviceIds = new Set<string>();
  for (const device of devices) {
    knownDeviceIds.add(device.deviceId);
    if (device.accountId) {
      deviceToAccount.set(device.deviceId, device.accountId);
    }
  }
  log.info(
    {
      accounts: accountIds.size,
      deviceMappings: deviceToAccount.size,
      mode: apply ? "apply" : "dry-run",
    },
    "[composio-migration] loaded DB lookups",
  );

  const composio = new Composio({
    apiKey: COMPOSIO_API_KEY,
    allowTracking: false,
  });
  const client = composio.getClient();

  const counts: MigrationCounts = {
    scanned: 0,
    alreadyMigrated: 0,
    moved: 0,
    needsReauth: 0,
    failed: 0,
    orphaned: 0,
    skippedNoAccount: 0,
  };

  // 2. Page through every connected account in the project.
  let cursor: string | null | undefined;
  do {
    const page = await client.connectedAccounts.list({
      cursor: cursor ?? null,
      limit: 100,
    });

    for (const item of page.items) {
      counts.scanned += 1;
      // Reading this field is the entire point of the migration.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const userId = item.user_id;
      const label = `${item.id} (toolkit=${item.toolkit.slug}, status=${item.status})`;

      // Already keyed by an accountId — nothing to do.
      if (accountIds.has(userId)) {
        counts.alreadyMigrated += 1;
        continue;
      }

      const targetAccountId = deviceToAccount.get(userId);
      if (!targetAccountId) {
        if (knownDeviceIds.has(userId)) {
          counts.skippedNoAccount += 1;
          log.warn(
            { connection: label, deviceId: userId },
            "[composio-migration] skip: device has no accountId",
          );
        } else {
          counts.orphaned += 1;
          log.warn(
            { connection: label, userId },
            "[composio-migration] orphan: user_id is neither an account nor a known device",
          );
        }
        continue;
      }

      // Device-keyed connection we can move to targetAccountId.
      try {
        const detail = await client.connectedAccounts.retrieve(item.id);
        const secrets = presentSecretKeys(detail.state.val);

        if (secrets.length === 0) {
          counts.needsReauth += 1;
          log.warn(
            { connection: label },
            "[composio-migration] needs-reauth: no credential values readable in state (redacted?)",
          );
          continue;
        }

        if (!apply) {
          counts.moved += 1;
          log.info(
            { connection: label, from: userId, to: targetAccountId, secrets },
            "[composio-migration] would move",
          );
          continue;
        }

        const created = await client.connectedAccounts.create({
          auth_config: { id: detail.auth_config.id },
          connection: {
            user_id: targetAccountId,
            // Carry the existing credential state over verbatim.
            state: detail.state,
          },
        });

        // Create succeeded — now delete the original. If THIS fails we must roll
        // back the new connection, otherwise a retry would skip the new one as
        // alreadyMigrated, re-process the still-present old one, and create a
        // duplicate (then a triplicate, ...).
        try {
          await client.connectedAccounts.delete(item.id);
        } catch (deleteError) {
          counts.failed += 1;
          let rolledBack = false;
          try {
            await client.connectedAccounts.delete(created.id);
            rolledBack = true;
          } catch (rollbackError) {
            // Both deletes failed: old + new now coexist. Flag loudly — a retry
            // could duplicate again, so this needs manual cleanup in Composio.
            log.error(
              {
                connection: label,
                newConnection: created.id,
                error: rollbackError,
              },
              "[composio-migration] CRITICAL: old delete failed AND new rollback failed; manual cleanup required (duplicate connection)",
            );
          }
          log.error(
            {
              connection: label,
              newConnection: created.id,
              rolledBack,
              error: deleteError,
            },
            "[composio-migration] delete of old connection failed; rolled back new to keep retry idempotent",
          );
          continue;
        }

        counts.moved += 1;
        log.info(
          {
            oldConnection: item.id,
            newConnection: created.id,
            from: userId,
            to: targetAccountId,
          },
          "[composio-migration] moved",
        );
      } catch (error) {
        // retrieve or create failed. Legacy-retired is a permanent re-auth case;
        // anything else is a (possibly transient) API failure we can retry.
        // Detect the legacy-retired error by name rather than importing the
        // class, so this compiles across @composio/core versions regardless of
        // whether they export it.
        const isLegacyRetired =
          error instanceof Error &&
          error.name === "ComposioLegacyConnectedAccountsEndpointRetiredError";
        if (isLegacyRetired) {
          counts.needsReauth += 1;
          log.warn(
            { connection: label },
            "[composio-migration] needs-reauth: legacy create endpoint retired for this auth config",
          );
        } else {
          counts.failed += 1;
          log.error(
            { connection: label, error },
            "[composio-migration] failed: retrieve/create errored (retried next run)",
          );
        }
      }
    }

    cursor = page.next_cursor;
  } while (cursor);

  log.info({ counts }, "[composio-migration] pass complete");
  return counts;
}

/**
 * Boot-time guard that runs the migration exactly once per environment, like a
 * DB migration. Safe to call on every startup:
 *   - short-circuits if the ledger marker is already "done";
 *   - takes a transaction-scoped Postgres advisory lock so concurrent replicas
 *     can't both run it (the lock auto-releases when the transaction ends);
 *   - on a successful pass, records the marker so future boots skip it;
 *   - never throws — a failure just leaves the marker unset so the next boot
 *     retries.
 */
export async function runComposioUserIdMigrationOnce() {
  if (!COMPOSIO_API_KEY) return;

  try {
    const existing = await prisma.runtimeConfig.findUnique({
      where: { key: COMPOSIO_USER_ID_MIGRATION_KEY },
    });
    if (existing?.value === "done") return;

    await prisma.$transaction(
      async (tx) => {
        const lockRows = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked
        `;
        if (!lockRows[0]?.locked) {
          logger.info(
            "[composio-migration] advisory lock held by another instance; skipping",
          );
          return;
        }

        // Re-check inside the lock in case a peer finished while we waited.
        const inside = await tx.runtimeConfig.findUnique({
          where: { key: COMPOSIO_USER_ID_MIGRATION_KEY },
        });
        if (inside?.value === "done") return;

        const counts = await migrateComposioConnectionsToAccountId({
          apply: true,
          log: logger,
          db: tx,
        });
        await tx.runtimeConfig.upsert({
          where: { key: COMPOSIO_USER_ID_MIGRATION_KEY },
          create: { key: COMPOSIO_USER_ID_MIGRATION_KEY, value: "done" },
          update: { value: "done" },
        });
        logger.info(
          { counts },
          "[composio-migration] completed and marked done",
        );
      },
      // External Composio HTTP calls run inside the lock; give the one-time pass
      // plenty of headroom rather than the 5s interactive-tx default.
      { timeout: 10 * 60 * 1000, maxWait: 15_000 },
    );
  } catch (error) {
    logger.error(
      { error },
      "[composio-migration] run failed; will retry on next boot",
    );
  }
}
