import { Router } from "express";
import { requireAccount } from "@/middleware/auth";
import { agentParticipationLimiter } from "@/middleware/rateLimit";
import { conversationAbilitiesGetHandler } from "./handlers/abilities-get";
import { conversationAbilityDeleteHandler } from "./handlers/ability-delete";
import { conversationAbilityPutHandler } from "./handlers/ability-put";
import {
  getParticipationHandler,
  participationHandler,
} from "./handlers/participation";

// /v2/conversations — conversation-scoped surfaces. Mounted behind
// authMiddleware in src/api/v2/index.ts; every route here applies
// requireAccount itself. conversationId is the opaque XMTP string (no
// Conversation table).
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

// Conversation-scoped ability extensions (Connections V2,
// docs/plans/abilities-entitlements.md "Extend"). Every route is a
// signed-in-account surface.
conversationsRouter.get(
  "/:conversationId/abilities",
  requireAccount,
  conversationAbilitiesGetHandler,
);
conversationsRouter.put(
  "/:conversationId/abilities/:abilityId",
  requireAccount,
  conversationAbilityPutHandler,
);
conversationsRouter.delete(
  "/:conversationId/abilities/:abilityId",
  requireAccount,
  conversationAbilityDeleteHandler,
);
