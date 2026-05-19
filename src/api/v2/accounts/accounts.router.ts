import { Router } from "express";
import { requireAccount } from "@/middleware/auth";
import { creditsGetHandler } from "./handlers/credits-get";
import { subscriptionGetHandler } from "./handlers/subscription-get";
import { subscriptionVerifyHandler } from "./handlers/subscription-verify";

/**
 * User-facing /accounts/me/* surface. Per the agent vs user namespace
 * separation: agents read/write balance via /credits/{check,consume,grant}
 * with X-Agent-API-Key; users read their own account state via this router
 * with JWT + requireAccount. Parent mount in v2/index.ts supplies
 * authMiddleware so res.locals.accountId is populated here.
 */
export const accountsRouter = Router();

accountsRouter.get("/me/credits", requireAccount, creditsGetHandler);
accountsRouter.get("/me/subscription", requireAccount, subscriptionGetHandler);
accountsRouter.post(
  "/me/subscription/verify",
  requireAccount,
  subscriptionVerifyHandler,
);
