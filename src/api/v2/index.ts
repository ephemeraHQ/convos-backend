import { Router } from "express";
import {
  appCheckOnlyMiddleware,
  authMiddleware,
  authMiddlewareAllowNSE,
} from "@/middleware/auth";
import { lifecycleTestAuthMiddleware } from "@/middleware/lifecycleTestAuth";
import { assetRenewalLimiter } from "@/middleware/rateLimit";
import { assetsRouter } from "./assets/assets.router";
import { lifecycleStatusHandler } from "./assets/handlers/lifecycle-status";
import { migrateTimestampsHandler } from "./assets/handlers/migrate-timestamps";
import { testLifecycleHandler } from "./assets/handlers/test-lifecycle";
import { attachmentsRouter } from "./attachments/attachments.router";
import { authRouter } from "./auth/auth.router";
import { deviceRouter } from "./device/device.router";
import invitesV2Router from "./invites/invites.router";
import { notificationsRouter } from "./notifications/notifications.router";
import { webhookRouter } from "./notifications/webhook.router";

const v2Router = Router();

v2Router.use("/invites", invitesV2Router);
v2Router.use("/auth", authRouter);
v2Router.use("/device", appCheckOnlyMiddleware, deviceRouter);

// Lifecycle test endpoints - protected by token auth, must be before authenticated /assets route
v2Router.post(
  "/assets/test/lifecycle",
  lifecycleTestAuthMiddleware,
  assetRenewalLimiter,
  testLifecycleHandler,
);
v2Router.post(
  "/assets/test/lifecycle-status",
  lifecycleTestAuthMiddleware,
  assetRenewalLimiter,
  lifecycleStatusHandler,
);
// One-time migration endpoint - remove after lifecycle rule is enabled
v2Router.post(
  "/assets/test/migrate-timestamps",
  lifecycleTestAuthMiddleware,
  migrateTimestampsHandler,
);

v2Router.use("/assets", authMiddleware, assetRenewalLimiter, assetsRouter);
v2Router.use("/attachments", authMiddleware, attachmentsRouter);
v2Router.use("/notifications/xmtp", webhookRouter);
v2Router.use("/notifications", authMiddleware, notificationsRouter);

// Auth check endpoint - allows NSE tokens for diagnostics
v2Router.get("/auth-check", authMiddlewareAllowNSE, (_req, res) => {
  res.status(200).json({
    success: true,
  });
  return;
});

export default v2Router;
