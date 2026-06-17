import { Router } from "express";
import { meGuard } from "@/api/v2/accounts/middleware/meGuard";
import { accountViewGetHandler } from "./handlers/account-view-get";
import { searchGetHandler } from "./handlers/search-get";
import { cfAccessHeaderMiddleware } from "./middleware/cf-access";

export const creditsAdminRouter = Router();

creditsAdminRouter.get("/search", cfAccessHeaderMiddleware, searchGetHandler);

creditsAdminRouter.get(
  "/accounts/:accountId",
  cfAccessHeaderMiddleware,
  meGuard,
  accountViewGetHandler,
);
