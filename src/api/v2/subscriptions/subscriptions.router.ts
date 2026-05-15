import { Router } from "express";
import { requireAccount } from "@/middleware/auth";
import { meGetHandler } from "./handlers/me-get";
import { meVerifyHandler } from "./handlers/me-verify";

export const subscriptionsRouter = Router();

// Both /me endpoints require an account context. `authMiddleware` is mounted
// at the parent (v2/index.ts) so res.locals.accountId is already populated
// from the JWT — requireAccount just gates on its presence.
subscriptionsRouter.get("/me", requireAccount, meGetHandler);
subscriptionsRouter.post("/me/verify", requireAccount, meVerifyHandler);
