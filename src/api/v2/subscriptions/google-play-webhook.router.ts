import { Router } from "express";
import { googlePlayRtdnHandler } from "./handlers/google-play-rtdn";

export const googlePlayWebhookRouter = Router();

// Google authenticates via the OIDC bearer in the Authorization header,
// verified inside the handler — no auth middleware.
googlePlayWebhookRouter.post("/rtdn", googlePlayRtdnHandler);
