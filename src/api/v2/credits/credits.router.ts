import { Router } from "express";
import { agentApiKeyAuth } from "@/middleware/agentAuth";
import { requireCronApiKey } from "./middleware/cron-api-key";
import { check } from "./handlers/check";
import { consume } from "./handlers/consume";
import { dailyRefill } from "./handlers/daily-refill";
import { grant } from "./handlers/grant";

const creditsRouter = Router();

// TODO: add rate-limit middleware before per-instance API keys ship.
// A leaked AGENT_ASSETS_API_KEY currently allows N consume calls per
// account up to MIN_BALANCE_CREDITS floor with zero throttling.
creditsRouter.post("/check", agentApiKeyAuth, check);
creditsRouter.post("/consume", agentApiKeyAuth, consume);
creditsRouter.post("/grant", agentApiKeyAuth, grant);

// Cron-only — separate gate (PAYMENTS_CRON_API_KEY), not agent key.
creditsRouter.post("/daily", requireCronApiKey, dailyRefill);

export { creditsRouter };
