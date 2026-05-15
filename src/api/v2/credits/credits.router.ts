import { Router } from "express";
import { agentApiKeyAuth } from "@/middleware/agentAuth";
import { check } from "./handlers/check";
import { consume } from "./handlers/consume";
import { grant } from "./handlers/grant";

const creditsRouter = Router();

// TODO: add rate-limit middleware before per-instance API keys ship.
// A leaked AGENT_ASSETS_API_KEY currently allows N consume calls per
// account up to MIN_BALANCE_CREDITS floor with zero throttling.
creditsRouter.post("/check", agentApiKeyAuth, check);
creditsRouter.post("/consume", agentApiKeyAuth, consume);
creditsRouter.post("/grant", agentApiKeyAuth, grant);

export { creditsRouter };
