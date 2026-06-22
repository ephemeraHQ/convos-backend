import type { Request, Response } from "express";
import {
  runEntitlementReconcile,
  type EntitlementReconcileSummary,
} from "@/subscriptions/reconcile/service";

/**
 * POST /v2/credits/reconcile
 *
 * Cron-gated entitlement reconciliation. Re-fetches provider ground truth for
 * at-risk subscriptions and refreshes the local entitlement window. Writes no
 * credit rows — only refreshes the Subscription row the derived read trusts.
 *   200  { scanned, refreshed, noOp, skipped, errors, runAt }  — ran
 *   500  { error: "Entitlement reconcile failed" }             — job threw
 */
export async function reconcile(req: Request, res: Response) {
  let summary: EntitlementReconcileSummary;
  try {
    summary = await runEntitlementReconcile();
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "credits.entitlement_reconcile.failed",
    );
    res.status(500).json({ error: "Entitlement reconcile failed" });
    return;
  }

  req.log.info(
    {
      scanned: summary.scanned,
      refreshed: summary.refreshed.length,
      noOp: summary.noOp,
      skipped: summary.skipped,
      errors: summary.errors.length,
    },
    "credits.entitlement_reconcile.completed",
  );
  if (summary.errors.length > 0) {
    req.log.warn(
      { errorCount: summary.errors.length, errors: summary.errors },
      "credits.entitlement_reconcile.partial_errors",
    );
  }

  res.status(200).json({
    scanned: summary.scanned,
    refreshed: summary.refreshed.length,
    noOp: summary.noOp,
    skipped: summary.skipped,
    errors: summary.errors.length,
    runAt: summary.runAt.toISOString(),
  });
}
