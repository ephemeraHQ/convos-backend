#!/usr/bin/env tsx

/**
 * One-time n=1 materialization of the single-ledger migration.
 *
 * Before this migration, subscription allotments were DERIVED at read time and
 * never written to the ledger. After it, the wallet (`UserCredits.balance`) is
 * the only spendable truth and subscriptions write a real `sub_grant` row per
 * period (on subscribe/renewal). Until a live subscriber's next renewal/verify
 * lands, their wallet would not yet hold the current period's credits.
 *
 * This script materializes the CURRENT period for every entitled subscription
 * that has not been granted yet, using the SAME idempotency key the
 * verify/renewal path uses (`sub_grant_{subscriptionId}_{periodStartEpoch}`).
 * It is therefore:
 *   - idempotent: re-running, or the next renewal/verify, no-ops on the key;
 *   - indistinguishable from a live grant: it writes the FULL `perPeriod`
 *     allotment — exactly what `grantSubscriptionPeriod` writes (which never
 *     clamps). This is REQUIRED for forfeit correctness: live forfeit reads the
 *     `sub_grant` row back as the period's TOTAL grant and subtracts period
 *     consumes once. A clamped (`perPeriod − consumed`) row would make forfeit
 *     subtract the pre-migration consumes a SECOND time → under-forfeit. Any
 *     credits the subscriber already burned this period are already reflected in
 *     the wallet balance, so writing the full grant is not over-crediting — it
 *     simply restores the period's allotment as the live path would have.
 *
 * Sized for n=1 (one live subscriber). NO cutover state machine, NO dual-write,
 * NO backfill-safety harness — it is a guarded loop you can read in one screen.
 * Dry-run is the default and mutates nothing.
 *
 * Usage:
 *   pnpm tsx --env-file=.env dev/scripts/materializeSubscriptionWallets.ts
 *   pnpm tsx --env-file=.env dev/scripts/materializeSubscriptionWallets.ts --apply
 */
import { grant } from "@/payments";
import { config } from "@/payments/credits/config";
import { subGrantKey } from "@/subscriptions/grants";
import { ENTITLED_SUBSCRIPTION_STATUSES } from "@/subscriptions/status";
import { tierGrant } from "@/subscriptions/tier-config";
import { requireSubscriptionTier } from "@/subscriptions/tiers";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

const APPLY = process.argv.includes("--apply");

export interface MaterializeResult {
  total: number;
  granted: number;
  skipped: number;
}

/**
 * Core materialization loop. Exported so tests can drive it directly (the live
 * forfeit math depends on the FULL-`perPeriod` grant this writes). `apply=false`
 * is a dry-run that mutates nothing.
 */
export async function materializeSubscriptionWallets(
  apply: boolean,
): Promise<MaterializeResult> {
  // Touch config so a missing PAYMENTS_GRANT_PLUS_MONTHLY fails fast here too.
  void config.grantPlusMonthlyCredits;

  const subs = await prisma.subscription.findMany({
    where: { status: { in: ENTITLED_SUBSCRIPTION_STATUSES } },
  });

  let granted = 0;
  let skipped = 0;

  for (const sub of subs) {
    const periodStart = sub.currentPeriodStart;
    const idempotencyKey = subGrantKey(sub.id, periodStart);

    const already = await prisma.creditLedger.findUnique({
      where: {
        accountId_idempotencyKey: {
          accountId: sub.accountId,
          idempotencyKey,
        },
      },
    });
    if (already) {
      skipped++;
      logger.info(
        { subscriptionId: sub.id, accountId: sub.accountId },
        "[materialize-subs] already granted this period — skipping",
      );
      continue;
    }

    // Write the FULL per-period allotment — identical to what the live
    // `grantSubscriptionPeriod` writes (it never clamps). Forfeit reads this row
    // back as the period TOTAL and nets period consumes ONCE; clamping here
    // would make it net the pre-migration consumes a second time (under-forfeit).
    // Credits already spent this period are already deducted from the wallet
    // balance, so the full grant is not over-crediting.
    const credits = tierGrant(
      requireSubscriptionTier(sub.tier),
      sub.period,
    ).perPeriod;

    if (credits <= 0) {
      skipped++;
      logger.info(
        { subscriptionId: sub.id, perPeriod: credits },
        "[materialize-subs] nothing to credit this period — skipping",
      );
      continue;
    }

    if (!apply) {
      granted++;
      logger.info(
        { subscriptionId: sub.id, accountId: sub.accountId, credits },
        "[materialize-subs] DRY-RUN would grant",
      );
      continue;
    }

    await grant({
      accountId: sub.accountId,
      credits,
      kind: "sub_grant",
      idempotencyKey,
      note: `n=1 materialize subscription ${sub.id} period ${periodStart.toISOString()}`,
    });
    granted++;
    logger.info(
      { subscriptionId: sub.id, accountId: sub.accountId, credits },
      "[materialize-subs] granted",
    );
  }

  logger.info(
    { total: subs.length, granted, skipped, apply },
    "[materialize-subs] finished",
  );
  if (!apply) {
    logger.info(
      "[materialize-subs] dry-run only — re-run with --apply to write the grants",
    );
  }

  return { total: subs.length, granted, skipped };
}

// Only run the CLI when invoked directly (not when imported by a test). tsx sets
// import.meta.url to the entrypoint's file URL.
const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  materializeSubscriptionWallets(APPLY)
    .catch((error: unknown) => {
      logger.error({ error }, "[materialize-subs] CLI failed");
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
