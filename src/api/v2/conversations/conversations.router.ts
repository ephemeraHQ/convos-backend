import { Router } from "express";
import { requireAccount } from "@/middleware/auth";
import { agentParticipationLimiter } from "@/middleware/rateLimit";
import {
  getParticipationHandler,
  participationHandler,
} from "./handlers/participation";

export const conversationsRouter = Router();

// How much the agents in this conversation may speak. `requireAccount` for the
// same reason as /agents/join: an account-less JWT is an authorization failure,
// not a stale token. The product rule is that any member may change the level,
// so this deliberately has no owner gate; membership itself lives in the XMTP
// group and is not verifiable here.
//
// The read is unthrottled beyond the shared limiter: every member's client
// calls it to render the control, and it is answered upstream from a stored
// record without waking an agent.
conversationsRouter.get(
  "/:conversationId/participation",
  requireAccount,
  getParticipationHandler,
);

conversationsRouter.patch(
  "/:conversationId/participation",
  agentParticipationLimiter,
  requireAccount,
  participationHandler,
);
