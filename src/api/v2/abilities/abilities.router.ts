import { Router } from "express";
import { requireAccount } from "@/middleware/auth";
import { entitlementCompleteHandler } from "./handlers/entitlement-complete";
import { entitlementDeleteHandler } from "./handlers/entitlement-delete";
import { entitlementPostHandler } from "./handlers/entitlement-post";
import { abilitiesListHandler } from "./handlers/list";

// /v2/abilities — the Connections V2 ability surface. Auth is applied at the
// mount point in src/api/v2/index.ts (authMiddleware, deliberately without
// requireAccount — see the list handler's contract). The entitlement
// lifecycle routes add requireAccount per-route: browsing is device-token
// friendly, binding is account-only.
export const abilitiesRouter = Router();

abilitiesRouter.get("/", abilitiesListHandler);

abilitiesRouter.post(
  "/:abilityId/entitlement",
  requireAccount,
  entitlementPostHandler,
);
abilitiesRouter.post(
  "/:abilityId/entitlement/complete",
  requireAccount,
  entitlementCompleteHandler,
);
abilitiesRouter.delete(
  "/:abilityId/entitlement",
  requireAccount,
  entitlementDeleteHandler,
);
