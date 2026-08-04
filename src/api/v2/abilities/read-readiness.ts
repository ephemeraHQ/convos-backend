import {
  ABILITY_ENTITLEMENTS_BACKFILL_KEY,
  ABILITY_ENTITLEMENTS_CUTOVER_KEY,
  isBackfillLedgerCurrent,
} from "@/api/v2/abilities/backfill-entitlements";
import { COMPOSIO_USER_ID_MIGRATION_KEY } from "@/api/v2/connections/migrate-user-ids";
import { prisma } from "@/utils/prisma";

// Cutover gate for the entitlement-table READ model (exec's checkEntitlement).
//
// A freshly deployed replica must not authorize from the new tables while
// they are still being populated: the user-id migration re-keys Composio
// ownership to accountIds, and the entitlement backfill converges V1 state on
// top of it — both run asynchronously after listen, on ONE replica at a time
// (advisory locks), and either can be incomplete or failed on any given boot.
// Serving new-table-only reads before the ledgers confirm completion would
// deny every existing grant on that replica.
//
// So the conversation check falls back to the legacy ConnectionGrant matcher
// (byte-identical V1 semantics) until ALL THREE RuntimeConfig ledgers
// confirm:
//   - the user-id migration marker is "done",
//   - the backfill marker has reached the CURRENT code epoch, and
//   - the CUTOVER marker has reached the current epoch — written only by the
//     post-drain step (see backfill-entitlements.ts): the pass marker alone
//     proves a snapshot converged, not that old replicas stopped writing
//     legacy rows after that snapshot. An epoch bump therefore also returns
//     reads to the legacy matcher until its sweep completes AND drains — the
//     legacy table keeps being dual-written for exactly this reason.
//
// Readiness is monotonic per process: once the ledgers confirm, the answer
// is cached for the process lifetime (ledgers only move forward for a given
// code version). While not ready, the primary-key lookups run per check —
// cheap, and only for as long as the window lasts.

let confirmedReady = false;
let testOverride: boolean | null = null;

/**
 * Pin readiness in tests (true = new-table reads, false = legacy fallback);
 * null restores real ledger-driven behavior.
 */
export function __setEntitlementReadReadinessForTests(
  value: boolean | null,
): void {
  testOverride = value;
  confirmedReady = false;
}

/** True once the migration ledgers confirm the new tables are complete. */
export async function isEntitlementReadModelReady(): Promise<boolean> {
  if (testOverride !== null) return testOverride;
  if (confirmedReady) return true;

  const [migration, backfill, cutover] = await Promise.all([
    prisma.runtimeConfig.findUnique({
      where: { key: COMPOSIO_USER_ID_MIGRATION_KEY },
    }),
    prisma.runtimeConfig.findUnique({
      where: { key: ABILITY_ENTITLEMENTS_BACKFILL_KEY },
    }),
    prisma.runtimeConfig.findUnique({
      where: { key: ABILITY_ENTITLEMENTS_CUTOVER_KEY },
    }),
  ]);
  const ready =
    migration?.value === "done" &&
    isBackfillLedgerCurrent(backfill?.value) &&
    isBackfillLedgerCurrent(cutover?.value);
  if (ready) confirmedReady = true;
  return ready;
}
