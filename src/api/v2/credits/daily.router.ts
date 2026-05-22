import { Router } from "express";
import { dailyRefill } from "./handlers/daily-refill";
import { requireCronApiKey } from "./middleware/cron-api-key";

/**
 * Cron-API-key-gated /v2/credits/daily route. External AWS EventBridge
 * Scheduler hits this once per UTC day.
 *
 * Replaces the broader credits.router.ts which also exposed
 * /v2/credits/{check,consume,grant} — those routes are removed in Task 16
 * (hard cutover).
 */
export const dailyRefillRouter = Router();

dailyRefillRouter.post("/daily", requireCronApiKey, dailyRefill);
