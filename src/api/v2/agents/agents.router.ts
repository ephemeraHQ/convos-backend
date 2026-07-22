import { Router } from "express";
import { requireAccount } from "@/middleware/auth";
import {
  agentJoinLimiter,
  agentJoinStatusLimiter,
  agentParticipationLimiter,
} from "@/middleware/rateLimit";
import { joinHandler } from "./handlers/join";
import { joinStatusHandler } from "./handlers/join-status";
import { participationHandler } from "./handlers/participation";

export const agentsRouter = Router();

// Tight limit on provisioning (10/5min) — each call kicks off an expensive
// upstream container-boot workflow.
//
// `requireAccount` 403s a valid-but-account-less JWT, matching the
// /accounts/me/* surface. A valid JWT that carries no `accountId` is an
// authorization failure, not an authentication one, so it must NOT be a
// 401 — iOS treats a 401 as "stale token" and burns its re-auth retry
// budget re-minting the same account-less token, surfacing as a confusing
// `notAuthenticated`. A 403 fails honestly and breaks that loop.
agentsRouter.post("/join", agentJoinLimiter, requireAccount, joinHandler);
// Generous limit on status polling (60/5min) — clients on the fallback
// async path may poll every ~5s; status reads have no upstream side-effects.
agentsRouter.get(
  "/join/:instanceId",
  agentJoinStatusLimiter,
  joinStatusHandler,
);
// Sets how much an agent may speak. `requireAccount` for the same reason as
// /join: an account-less JWT is an authorization failure, not a stale token.
// The product rule is that any conversation member may change the level, so
// this deliberately has no owner gate; membership itself lives in the XMTP
// group and is not verifiable here.
agentsRouter.patch(
  "/:instanceId/participation",
  agentParticipationLimiter,
  requireAccount,
  participationHandler,
);
