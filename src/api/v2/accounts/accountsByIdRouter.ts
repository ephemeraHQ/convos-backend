import { Router } from "express";
import { creditsByIdGetHandler } from "./handlers/credits-by-id-get";
import { creditsGrantsPostHandler } from "./handlers/credits-grants-post";
import { creditsTransactionsPostHandler } from "./handlers/credits-transactions-post";
import { creditsUsageGetHandler } from "./handlers/credits-usage-get";

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
// mergeParams: true so child handlers see :accountId from the parent mount in
// src/api/v2/index.ts. Without this, Express 5 / router 2.x leaves
// req.params.accountId undefined here, and zod parses of req.params fail.
export const accountsByIdRouter = Router({ mergeParams: true });

accountsByIdRouter.get("/credits", creditsByIdGetHandler);
accountsByIdRouter.get("/credits/usage", creditsUsageGetHandler);
accountsByIdRouter.post(
  "/credits/transactions",
  creditsTransactionsPostHandler,
);
accountsByIdRouter.post("/credits/grants", creditsGrantsPostHandler);
