import { Router } from "express";
import { requireAccount } from "@/middleware/auth";
import { meBalanceHandler } from "./handlers/me-balance";

/**
 * User-facing /credits/me/* surface. Mounted in parallel with the
 * agent-facing creditsRouter (which handles /check, /consume, /grant via
 * agentApiKeyAuth). The two routers don't share auth — parent v2 mount
 * supplies authMiddleware before this router so res.locals.accountId is
 * populated.
 */
export const creditsMeRouter = Router();

creditsMeRouter.get("/balance", requireAccount, meBalanceHandler);
