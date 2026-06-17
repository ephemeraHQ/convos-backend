import { Router } from "express";
import { googlePlayRtdnHandler } from "./handlers/google-play-rtdn";

/**
 * Mount point for Google Play webhooks. Exposes `/rtdn` for Pub/Sub-push
 * delivery of Real-time Developer Notifications. Auth is handled inside
 * `googlePlayRtdnHandler` (OIDC bearer verification), not by middleware.
 */
export const googlePlayWebhookRouter = Router();

googlePlayWebhookRouter.post("/rtdn", googlePlayRtdnHandler);
