import { Router } from "express";
import { requireAccount } from "@/middleware/auth";
import {
  accountDeletionAccountLimiter,
  accountDeletionIpLimiter,
  subscriptionClaimAccountLimiter,
  subscriptionClaimGlobalLimiter,
  subscriptionClaimIpLimiter,
} from "@/middleware/rateLimit";
import { accountDeleteHandler } from "./handlers/account-delete";
import { creditsGetHandler } from "./handlers/credits-get";
import {
  claimAppCheckMiddleware,
  subscriptionClaimHandler,
} from "./handlers/subscription-claim";
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
// Explicit one-time subscription ownership claim. Fail-closed requireAccount
// (claims into the caller's live account only) plus a mandatory, consumed
// App Check attestation before any provider call.
accountsMeRouter.post(
  "/subscription/claim",
  subscriptionClaimIpLimiter,
  subscriptionClaimAccountLimiter,
  subscriptionClaimGlobalLimiter,
  requireAccount,
  claimAppCheckMiddleware,
  subscriptionClaimHandler,
);
// Account deletion. Deliberately not behind requireAccount: the handler owns
// an endpoint-specific auth carve-out so an unexpired pre-deletion token can
// re-read the stored deletion record (idempotent retry) after the account
// row is gone. See the handler doc comment.
accountsMeRouter.delete(
  "/",
  accountDeletionIpLimiter,
  accountDeletionAccountLimiter,
  accountDeleteHandler,
);
