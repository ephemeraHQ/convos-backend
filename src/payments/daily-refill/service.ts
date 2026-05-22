import { LedgerReason } from "@prisma/client";
import { getBalance } from "@/payments";
import { config } from "@/payments/credits/config";
import { applyDelta } from "@/payments/ledger";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";
import { fanOutCreditsRefilled } from "./notify";
import { startOfTodayUtc, ymdUtc } from "./utc";

export type DailyRefillSummary = {
  skipped: boolean;
  reason?: "already_ran_today";
  lastRunAt?: Date;
  runAt?: Date;
  refilled: Array<{
    accountId: string;
    creditsAdded: number;
    newBalance: bigint;
  }>;
  noOp: number;
  errors: Array<{ accountId: string; error: string }>;
};

export async function lastRefillDateUTC(): Promise<Date | null> {
  const row = await prisma.creditLedger.findFirst({
    where: { grantKindId: "daily_refill" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

export async function runDailyRefill(opts?: {
  now?: Date;
}): Promise<DailyRefillSummary> {
  const now = opts?.now ?? new Date();
  const cap = config.freeTierDailyCapCredits;

  // 1. Self-rate-limit
  const lastRun = await lastRefillDateUTC();
  const startOfToday = startOfTodayUtc(now);
  if (lastRun && lastRun >= startOfToday) {
    logger.warn(
      { lastRunAt: lastRun.toISOString(), runAt: now.toISOString() },
      "daily_refill.skipped.already_ran_today",
    );
    return {
      skipped: true,
      reason: "already_ran_today",
      lastRunAt: lastRun,
      refilled: [],
      noOp: 0,
      errors: [],
    };
  }

  // 2. Eligibility — SIWE-verified non-subscribers.
  //    Active subscription = status IN (trial, active, grace, billingRetry)
  //    per src/subscriptions/repository.ts on louis/iap-credits-backend.
  const eligible = await prisma.$queryRaw<Array<{ account_id: string }>>`
    SELECT a.id AS account_id
    FROM "Account" a
    WHERE EXISTS (
      SELECT 1 FROM "AuthMethod" am
      WHERE am."accountId" = a.id
        AND am.type = 'SIWE'
    )
    AND NOT EXISTS (
      SELECT 1 FROM "Subscription" s
      WHERE s."accountId" = a.id
        AND s.status IN ('trial', 'active', 'grace', 'billingRetry')
    )
  `;

  const summary: DailyRefillSummary = {
    skipped: false,
    runAt: now,
    refilled: [],
    noOp: 0,
    errors: [],
  };
  const dayKey = ymdUtc(now);

  // 3. Per-account loop
  for (const { account_id: accountId } of eligible) {
    try {
      const balance = await getBalance(accountId);
      const positiveBalance = balance < 0n ? 0n : balance;
      const headroom = BigInt(cap) - positiveBalance;
      if (headroom <= 0n) {
        summary.noOp++;
        continue;
      }
      // headroom > 0n and cap is safe int, so headroom fits in Number
      const delta = Number(headroom);

      const result = await applyDelta({
        accountId,
        delta: BigInt(delta),
        reason: LedgerReason.grant,
        idempotencyKey: `daily_refill:${accountId}:${dayKey}`,
        scope: "daily_refill",
        grantKindId: "daily_refill",
        note: `Daily refill to cap ${cap}`,
      });
      summary.refilled.push({
        accountId,
        creditsAdded: delta,
        newBalance: result.newBalance,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, accountId, op: "daily_refill" },
        "daily_refill.grant.failed",
      );
      summary.errors.push({ accountId, error: message });
    }
  }

  logger.info(
    {
      refilled: summary.refilled.length,
      noOp: summary.noOp,
      errors: summary.errors.length,
      runAt: now.toISOString(),
    },
    "daily_refill.completed",
  );

  // Fire-and-forget — never block the response on push delivery.
  if (summary.refilled.length > 0) {
    void fanOutCreditsRefilled(summary.refilled, now).catch((err: unknown) => {
      logger.error(
        { err, op: "daily_refill_notify" },
        "daily_refill.notify.fanout_failed",
      );
    });
  }

  return summary;
}
