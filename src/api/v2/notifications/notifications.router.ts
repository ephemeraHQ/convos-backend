import { Router } from "express";
import { debugStatusLimiter } from "@/middleware/rateLimit";
import { debugStatus } from "./handlers/debug-status";
import { subscribe } from "./handlers/subscribe";
import { unregister } from "./handlers/unregister";
import { unsubscribe } from "./handlers/unsubscribe";

const notificationsRouter = Router();

// Push notification management routes
// All routes require JWT auth - applied via authMiddlewareAllowNSE at mount
// point in v2/index.ts. The middleware's NSE allowlist gates which routes
// accept NSE JWTs vs regular JWTs.
notificationsRouter.post("/subscribe", subscribe);
notificationsRouter.post("/unsubscribe", unsubscribe);
notificationsRouter.delete("/unregister/:clientId", unregister);

// Stack 2 T12: debug-status endpoint for the iOS DebugPushNotificationsView
// probe. Production-safe (hashes-only response), JWT-gated, rate-limited
// 1/sec/JWT via debugStatusLimiter.
notificationsRouter.post("/debug/status", debugStatusLimiter, debugStatus);

export { notificationsRouter };
