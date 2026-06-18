import { Router } from "express";
import { meGuard } from "@/api/v2/accounts/middleware/meGuard";
import { accountViewGetHandler } from "./handlers/account-view-get";
import { adjustPostHandler } from "./handlers/adjust-post";
import { adminPageHandler } from "./handlers/admin-page";
import { auditGetHandler } from "./handlers/audit-get";
import { grantPostHandler } from "./handlers/grant-post";
import { searchGetHandler } from "./handlers/search-get";
import { cfAccessHeaderMiddleware } from "./middleware/cf-access";

export const creditsAdminRouter = Router();

creditsAdminRouter.get("/", adminPageHandler);

creditsAdminRouter.get("/search", cfAccessHeaderMiddleware, searchGetHandler);

creditsAdminRouter.get("/audit", cfAccessHeaderMiddleware, auditGetHandler);

creditsAdminRouter.get(
  "/accounts/:accountId",
  cfAccessHeaderMiddleware,
  meGuard,
  accountViewGetHandler,
);

creditsAdminRouter.post(
  "/accounts/:accountId/grant",
  cfAccessHeaderMiddleware,
  meGuard,
  grantPostHandler,
);

creditsAdminRouter.post(
  "/accounts/:accountId/adjust",
  cfAccessHeaderMiddleware,
  meGuard,
  adjustPostHandler,
);
