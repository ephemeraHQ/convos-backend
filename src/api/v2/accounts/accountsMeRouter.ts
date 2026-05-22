import { Router } from "express";
import { requireAccount } from "@/middleware/auth";
import { creditsGetHandler } from "./handlers/credits-get";
import { subscriptionGetHandler } from "./handlers/subscription-get";
import { subscriptionVerifyHandler } from "./handlers/subscription-verify";

/**
 * JWT-authenticated /v2/accounts/me/* surface. Mounted under /v2/accounts/me
 * in src/api/v2/index.ts, gated by authMiddleware + requireAccount.
 *
 * The /:accountId/* agent-key surface lives in accountsByIdRouter (Task 14).
 */
export const accountsMeRouter = Router();

accountsMeRouter.get("/credits", requireAccount, creditsGetHandler);
accountsMeRouter.get("/subscription", requireAccount, subscriptionGetHandler);
accountsMeRouter.post(
  "/subscription/verify",
  requireAccount,
  subscriptionVerifyHandler,
);
