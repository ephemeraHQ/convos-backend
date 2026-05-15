import type { Request, Response } from "express";
import { runDailyRefill } from "@/payments/daily-refill/service";

export async function dailyRefill(req: Request, res: Response): Promise<void> {
  const summary = await runDailyRefill();
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
