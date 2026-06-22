import { Router } from "express";
import { reconcile } from "./handlers/reconcile";
import { requireCronApiKey } from "./middleware/cron-api-key";

/**
 * Cron-API-key-gated /v2/credits/reconcile route. External AWS EventBridge
 * Scheduler hits this on a schedule (hourly / every few hours) — the same
 * mechanism that drives /v2/credits/daily.
 *
 * Re-fetches provider ground truth for at-risk subscriptions and refreshes the
 * local entitlement window so dropped-webhook / dormant-app subs don't silently
 * lapse. Writes no credit rows.
 */
export const reconcileRouter = Router();

reconcileRouter.post("/reconcile", requireCronApiKey, reconcile);
