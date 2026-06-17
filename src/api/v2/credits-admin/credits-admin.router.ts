import { Router } from "express";
import { searchGetHandler } from "./handlers/search-get";
import { cfAccessHeaderMiddleware } from "./middleware/cf-access";

export const creditsAdminRouter = Router();

creditsAdminRouter.get("/search", cfAccessHeaderMiddleware, searchGetHandler);
