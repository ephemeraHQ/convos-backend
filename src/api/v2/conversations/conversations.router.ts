import { Router } from "express";
import { conversationAbilitiesGetHandler } from "./handlers/abilities-get";
import { conversationAbilityDeleteHandler } from "./handlers/ability-delete";
import { conversationAbilityPutHandler } from "./handlers/ability-put";

// /v2/conversations — conversation-scoped ability extensions (Connections V2,
// docs/plans/abilities-entitlements.md "Extend"). Mounted behind
// authMiddleware + requireAccount in src/api/v2/index.ts; conversationId is
// the opaque XMTP string (no Conversation table).
export const conversationsRouter = Router();

conversationsRouter.get(
  "/:conversationId/abilities",
  conversationAbilitiesGetHandler,
);
conversationsRouter.put(
  "/:conversationId/abilities/:abilityId",
  conversationAbilityPutHandler,
);
conversationsRouter.delete(
  "/:conversationId/abilities/:abilityId",
  conversationAbilityDeleteHandler,
);
