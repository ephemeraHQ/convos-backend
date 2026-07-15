import { Router } from "express";
import { meGuard } from "@/api/v2/accounts/middleware/meGuard";
import { accountViewGetHandler } from "./handlers/account-view-get";
import { adjustPostHandler } from "./handlers/adjust-post";
import { adminPageHandler } from "./handlers/admin-page";
import { auditGetHandler } from "./handlers/audit-get";
import { auditRecentGetHandler } from "./handlers/audit-recent-get";
import { grantPostHandler } from "./handlers/grant-post";
import { searchGetHandler } from "./handlers/search-get";
import { whoamiGetHandler } from "./handlers/whoami-get";
import { attachActorIdentity } from "./middleware/cf-identity";
import { creditsAdminTokenAuth } from "./middleware/token-auth";

export const creditsAdminRouter = Router();

// Public shell — authenticates client-side (Bearer), leaks no data server-side.
creditsAdminRouter.get("/", adminPageHandler);

// Reads — token gate only (no audit write).
creditsAdminRouter.get(
  "/whoami",
  creditsAdminTokenAuth,
  attachActorIdentity,
  whoamiGetHandler,
);
creditsAdminRouter.get("/search", creditsAdminTokenAuth, searchGetHandler);
creditsAdminRouter.get("/audit", creditsAdminTokenAuth, auditGetHandler);
creditsAdminRouter.get(
  "/audit/recent",
  creditsAdminTokenAuth,
  auditRecentGetHandler,
);
creditsAdminRouter.get(
  "/accounts/:accountId",
  creditsAdminTokenAuth,
  meGuard,
  accountViewGetHandler,
);

// Audited mutations — token gate, then verified CF identity, then UUID guard.
creditsAdminRouter.post(
  "/accounts/:accountId/grant",
  creditsAdminTokenAuth,
  attachActorIdentity,
  meGuard,
  grantPostHandler,
);
creditsAdminRouter.post(
  "/accounts/:accountId/adjust",
  creditsAdminTokenAuth,
  attachActorIdentity,
  meGuard,
  adjustPostHandler,
);
