#!/usr/bin/env tsx

/**
 * Local CLI wrapper around the Composio deviceId -> accountId migration.
 *
 * In deployed environments this runs automatically on boot (once per env, via
 * `runComposioUserIdMigrationOnce` in src/index.ts). This script is for running
 * it by hand — primarily the dry-run, to inspect what would happen and verify
 * credentials are actually readable before any environment applies it.
 *
 * Usage (dry-run is the default — it mutates nothing):
 *   pnpm tsx --env-file=.env dev/scripts/migrateComposioUserIds.ts
 *   pnpm tsx --env-file=.env dev/scripts/migrateComposioUserIds.ts --apply
 */
import { migrateComposioConnectionsToAccountId } from "@/api/v2/connections/migrate-user-ids";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

const APPLY = process.argv.includes("--apply");

migrateComposioConnectionsToAccountId({ apply: APPLY, log: logger })
  .then((counts) => {
    logger.info({ counts }, "[composio-migration] CLI finished");
    if (!APPLY) {
      logger.info(
        "[composio-migration] dry-run only — re-run with --apply to perform the move",
      );
    }
  })
  .catch((error: unknown) => {
    logger.error({ error }, "[composio-migration] CLI failed");
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
