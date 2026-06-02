import type { Request, Response } from "express";
import {
  runDailyRefill,
  type DailyRefillSummary,
} from "@/payments/daily-refill/service";

/**
 * POST /v2/credits/daily
 *
 * Cron-gated daily refill. Runs the top-up-to-cap job and returns a summary.
 *   200  { skipped: true, reason, lastRunAt }                   — already ran this UTC day
 *   200  { skipped: false, refilled, noOp, errors, runAt }      — ran
 *   500  { error: "Daily refill failed" }                       — job threw
 */
export async function dailyRefill(req: Request, res: Response) {
  let summary: DailyRefillSummary;
  try {
    summary = await runDailyRefill();
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "credits.daily_refill.failed",
    );
    res.status(500).json({ error: "Daily refill failed" });
    return;
  }

  req.log.info(
    {
      skipped: summary.skipped,
      reason: summary.reason,
      refilled: summary.refilled.length,
      noOp: summary.noOp,
      errors: summary.errors.length,
    },
    "credits.daily_refill.completed",
  );
  if (summary.errors.length > 0) {
    req.log.warn(
      { errorCount: summary.errors.length, errors: summary.errors },
      "credits.daily_refill.partial_errors",
    );
  }
  if (summary.skipped) {
    res.status(200).json({
      skipped: true,
      reason: summary.reason,
      lastRunAt: summary.lastRunAt?.toISOString(),
    });
    return;
  }
  res.status(200).json({
    skipped: false,
    refilled: summary.refilled.length,
    noOp: summary.noOp,
    errors: summary.errors.length,
    runAt: summary.runAt?.toISOString(),
  });
}
