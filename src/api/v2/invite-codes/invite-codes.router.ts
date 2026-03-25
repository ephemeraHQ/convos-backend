import { Router } from "express";
import { adminPageHandler } from "./handlers/admin-page";
import { generateHandler } from "./handlers/generate";
import { listHandler } from "./handlers/list";
import { redeemHandler } from "./handlers/redeem";

export const inviteCodesRouter = Router();

// Public (authenticated) endpoint — clients redeem codes here
inviteCodesRouter.post("/redeem", redeemHandler);

// Admin endpoints — protected by dev auth at the mount level
export const inviteCodesAdminRouter = Router();

// Serve the admin UI (HTML page) — no additional auth needed, the page
// authenticates client-side by sending the token on every API call
inviteCodesAdminRouter.get("/", listHandler);
inviteCodesAdminRouter.post("/generate", generateHandler);

// The admin HTML page is served without devAuth so the browser can load it,
// but every API call from the page includes the Bearer token.
export const inviteCodesAdminPageRouter = Router();
inviteCodesAdminPageRouter.get("/", adminPageHandler);
