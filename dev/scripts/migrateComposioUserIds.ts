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
 *   pnpm tsx --env-file=.env dev/scripts/migrateComposioUserIds.ts --apply --force
 *
 * --apply is a no-op if the environment's ledger already says "done"; pass
 * --force to apply again anyway (the move stays idempotent). Dry-run always runs.
 */
import {
  COMPOSIO_USER_ID_MIGRATION_KEY,
  migrateComposioConnectionsToAccountId,
} from "@/api/v2/connections/migrate-user-ids";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

async function main() {
  if (APPLY && !FORCE) {
    const marker = await prisma.runtimeConfig.findUnique({
      where: { key: COMPOSIO_USER_ID_MIGRATION_KEY },
    });
    if (marker?.value === "done") {
      logger.info(
        "[composio-migration] already marked done for this environment; pass --force to apply again (dry-run always runs)",
      );
      return;
    }
  }

  const counts = await migrateComposioConnectionsToAccountId({
    apply: APPLY,
    log: logger,
  });
  logger.info({ counts }, "[composio-migration] CLI finished");
  if (!APPLY) {
    logger.info(
      "[composio-migration] dry-run only — re-run with --apply to perform the move",
    );
  }
}

main()
  .catch((error: unknown) => {
    logger.error({ error }, "[composio-migration] CLI failed");
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
