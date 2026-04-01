import { Router } from "express";
import { devAuthMiddleware } from "@/middleware/devAuth";
import { adminPageHandler } from "./handlers/admin-page";
import { generateHandler } from "./handlers/generate";
import { listHandler } from "./handlers/list";
import { redeemHandler } from "./handlers/redeem";
import { statusHandler } from "./handlers/status";

export const inviteCodesRouter = Router();

// Public (authenticated) endpoints — clients redeem codes and check status here
inviteCodesRouter.post("/redeem", redeemHandler);
inviteCodesRouter.get("/:code/status", statusHandler);

// Admin router — single mount point, auth applied per-route
export const inviteCodesAdminRouter = Router();

// HTML page (no server auth — page authenticates client-side via Bearer token)
inviteCodesAdminRouter.get("/", adminPageHandler);

// API endpoints (devAuth-protected, called by the admin page)
inviteCodesAdminRouter.get("/codes", devAuthMiddleware, listHandler);
inviteCodesAdminRouter.post("/generate", devAuthMiddleware, generateHandler);
