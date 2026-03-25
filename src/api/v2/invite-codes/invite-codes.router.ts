import { Router } from "express";
import { generateHandler } from "./handlers/generate";
import { listHandler } from "./handlers/list";
import { redeemHandler } from "./handlers/redeem";

export const inviteCodesRouter = Router();

// Public (authenticated) endpoint — clients redeem codes here
inviteCodesRouter.post("/redeem", redeemHandler);

// Admin endpoints — protected by dev auth at the mount level
export const inviteCodesAdminRouter = Router();
inviteCodesAdminRouter.post("/generate", generateHandler);
inviteCodesAdminRouter.get("/", listHandler);
