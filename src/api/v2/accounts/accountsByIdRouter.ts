import { Router } from "express";
import { creditsByIdGetHandler } from "./handlers/credits-by-id-get";
import { creditsTransactionsPostHandler } from "./handlers/credits-transactions-post";
import { creditsGrantsPostHandler } from "./handlers/credits-grants-post";

/**
 * Agent-key-authenticated /v2/accounts/:accountId/* surface. Mounted under
 * /v2/accounts/:accountId in src/api/v2/index.ts (Task 16), gated by
 * agentApiKeyAuth + meGuard (UUID-only :accountId).
 *
 * Load-bearing invariant: no opt-in / auth-bypass middleware may be inserted
 * upstream of this mount. authMiddleware and agentApiKeyAuth both terminate
 * on auth failure (return after res.status(401).json(...)); they do not defer
 * to next(). meGuard is belt-and-suspenders for /:accountId === "me" cases.
 */
export const accountsByIdRouter = Router();

accountsByIdRouter.get("/credits", creditsByIdGetHandler);
accountsByIdRouter.post("/credits/transactions", creditsTransactionsPostHandler);
accountsByIdRouter.post("/credits/grants", creditsGrantsPostHandler);
