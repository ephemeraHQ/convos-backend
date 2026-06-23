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
 *   - clamped: it credits `perPeriod − min(periodConsumes, perPeriod)` so a
 *     subscriber who already burned part of the period mid-migration is not
 *     over-credited.
 *
 * Sized for n=1 (one live subscriber). NO cutover state machine, NO dual-write,
 * NO backfill-safety harness — it is a guarded loop you can read in one screen.
 * Dry-run is the default and mutates nothing.
 *
 * Usage:
 *   pnpm tsx --env-file=.env dev/scripts/materializeSubscriptionWallets.ts
 *   pnpm tsx --env-file=.env dev/scripts/materializeSubscriptionWallets.ts --apply
 */
import { LedgerReason } from "@prisma/client";
import { grant } from "@/payments";
import { config } from "@/payments/credits/config";
import { subGrantKey } from "@/subscriptions/grants";
import { ENTITLED_SUBSCRIPTION_STATUSES } from "@/subscriptions/status";
import { tierGrant } from "@/subscriptions/tier-config";
import { requireSubscriptionTier } from "@/subscriptions/tiers";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

const APPLY = process.argv.includes("--apply");

async function main() {
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

    const perPeriod = tierGrant(
      requireSubscriptionTier(sub.tier),
      sub.period,
    ).perPeriod;

    // Clamp by what was already consumed this period so we don't over-credit a
    // subscriber who spent part of the period before the migration landed.
    const consumeAgg = await prisma.creditLedger.aggregate({
      where: {
        accountId: sub.accountId,
        reason: LedgerReason.consume,
        createdAt: { gte: periodStart },
      },
      _sum: { delta: true },
    });
    const consumed =
      consumeAgg._sum.delta === null
        ? 0
        : Number(
            consumeAgg._sum.delta < 0n
              ? -consumeAgg._sum.delta
              : consumeAgg._sum.delta,
          );
    const credits = perPeriod - Math.min(consumed, perPeriod);

    if (credits <= 0) {
      skipped++;
      logger.info(
        { subscriptionId: sub.id, perPeriod, consumed },
        "[materialize-subs] nothing left to credit this period — skipping",
      );
      continue;
    }

    if (!APPLY) {
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
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { lastGrantedPeriodStart: periodStart },
    });
    granted++;
    logger.info(
      { subscriptionId: sub.id, accountId: sub.accountId, credits },
      "[materialize-subs] granted",
    );
  }

  logger.info(
    { total: subs.length, granted, skipped, apply: APPLY },
    "[materialize-subs] finished",
  );
  if (!APPLY) {
    logger.info(
      "[materialize-subs] dry-run only — re-run with --apply to write the grants",
    );
  }
}

main()
  .catch((error: unknown) => {
    logger.error({ error }, "[materialize-subs] CLI failed");
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
