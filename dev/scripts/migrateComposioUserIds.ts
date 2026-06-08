#!/usr/bin/env tsx

/**
 * ONE-TIME migration: move Composio connected accounts from being keyed by
 * `deviceId` to being keyed by the stable `accountId`.
 *
 * Background: connections used to be created in Composio with the per-device
 * `deviceId` as the Composio `user_id`. We now scope connections to the stable
 * account `accountId`. Composio's `user_id` cannot be renamed in place, but a
 * connection can be MOVED by re-creating it from its existing credentials under
 * a new `user_id`, then deleting the original. This carries OAuth tokens over,
 * so users do NOT have to re-authenticate.
 *
 * Per connection, classification is by DB membership (NOT by guessing UUID
 * shape, since both deviceId and accountId can be UUIDs):
 *   - user_id is a known Account.id          -> already migrated, skip
 *   - user_id is a known DeviceRegistration  -> MOVE to that device's accountId
 *   - neither                                -> orphan, log only (never touched)
 *
 * The move is retrieve -> create(under accountId, same state) -> delete(old).
 * If credentials can't be carried over (tokens redacted on read, or Composio's
 * legacy create endpoint is retired for this auth config), the original is left
 * intact and recorded as "needs re-auth" (the user simply reconnects).
 *
 * Idempotent: after a successful --apply, moved connections are keyed by
 * accountId (skipped on re-run) and originals are deleted, so re-running is a
 * no-op. Safe to run once per environment.
 *
 * Usage (dry-run is the default — it mutates nothing):
 *   pnpm tsx --env-file=.env dev/scripts/migrateComposioUserIds.ts
 *   pnpm tsx --env-file=.env dev/scripts/migrateComposioUserIds.ts --apply
 */
import {
  Composio,
  ComposioLegacyConnectedAccountsEndpointRetiredError,
} from "@composio/core";
import { COMPOSIO_API_KEY } from "@/config";
import { prisma } from "@/utils/prisma";

const APPLY = process.argv.includes("--apply");
const PAGE_LIMIT = 100;

// Credential fields that indicate the move can actually carry auth over.
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

function presentSecretKeys(val: unknown): string[] {
  if (typeof val !== "object" || val === null) return [];
  const record = val as Record<string, unknown>;
  return SECRET_KEYS.filter((key) => {
    const value = record[key];
    return typeof value === "string" && value.length > 0;
  });
}

async function main() {
  if (!COMPOSIO_API_KEY) {
    throw new Error("COMPOSIO_API_KEY is not set; cannot run migration.");
  }

  console.log(
    `[migrate] mode=${APPLY ? "APPLY (will mutate Composio)" : "DRY-RUN (no changes)"}`,
  );

  // 1. Build DB lookups.
  const accounts = await prisma.account.findMany({ select: { id: true } });
  const accountIds = new Set(accounts.map((a) => a.id));

  const devices = await prisma.deviceRegistration.findMany({
    select: { deviceId: true, accountId: true },
  });
  const deviceToAccount = new Map<string, string>();
  for (const device of devices) {
    if (device.accountId) {
      deviceToAccount.set(device.deviceId, device.accountId);
    }
  }
  console.log(
    `[migrate] loaded ${accountIds.size} accounts, ${deviceToAccount.size} device->account mappings`,
  );

  const composio = new Composio({
    apiKey: COMPOSIO_API_KEY,
    allowTracking: false,
  });
  const client = composio.getClient();

  const counts = {
    scanned: 0,
    alreadyMigrated: 0,
    moved: 0,
    needsReauth: 0,
    orphaned: 0,
    skippedNoAccount: 0,
  };

  // 2. Page through every connected account in the project.
  let cursor: string | null | undefined;
  do {
    const page = await client.connectedAccounts.list({
      cursor: cursor ?? null,
      limit: PAGE_LIMIT,
    });

    for (const item of page.items) {
      counts.scanned += 1;
      // The migration is fundamentally about this field; reading it is the point.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const userId = item.user_id;
      const label = `${item.id} (toolkit=${item.toolkit.slug}, status=${item.status})`;

      // Already keyed by an accountId — nothing to do.
      if (accountIds.has(userId)) {
        counts.alreadyMigrated += 1;
        continue;
      }

      // Not a known device either — leave it untouched.
      const targetAccountId = deviceToAccount.get(userId);
      if (!targetAccountId) {
        if (devices.some((d) => d.deviceId === userId)) {
          // Known device but no account bound — can't target an accountId.
          counts.skippedNoAccount += 1;
          console.log(
            `[migrate] SKIP ${label}: device ${userId} has no accountId`,
          );
        } else {
          counts.orphaned += 1;
          console.log(
            `[migrate] ORPHAN ${label}: user_id ${userId} is neither an account nor a known device`,
          );
        }
        continue;
      }

      // It's a device-keyed connection we can move to targetAccountId.
      try {
        const detail = await client.connectedAccounts.retrieve(item.id);
        const secrets = presentSecretKeys(detail.state.val);

        if (secrets.length === 0) {
          counts.needsReauth += 1;
          console.log(
            `[migrate] NEEDS-REAUTH ${label}: no credential values readable in state (redacted?) — user must reconnect`,
          );
          continue;
        }

        if (!APPLY) {
          counts.moved += 1;
          console.log(
            `[migrate] WOULD MOVE ${label}: device ${userId} -> account ${targetAccountId} (credentials present: ${secrets.join(", ")})`,
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
        await client.connectedAccounts.delete(item.id);
        counts.moved += 1;
        console.log(
          `[migrate] MOVED ${label}: ${item.id} (device ${userId}) -> ${created.id} (account ${targetAccountId})`,
        );
      } catch (error) {
        counts.needsReauth += 1;
        if (
          error instanceof ComposioLegacyConnectedAccountsEndpointRetiredError
        ) {
          console.log(
            `[migrate] NEEDS-REAUTH ${label}: legacy create endpoint retired for this auth config — user must reconnect`,
          );
        } else {
          console.error(`[migrate] NEEDS-REAUTH ${label}: move failed`, error);
        }
      }
    }

    cursor = page.next_cursor;
  } while (cursor);

  console.log("[migrate] summary:", JSON.stringify(counts, null, 2));
  if (!APPLY) {
    console.log(
      "[migrate] DRY-RUN complete. Re-run with --apply to perform the move.",
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error("[migrate] fatal error", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
