import { Router } from "express";
import {
  appCheckOnlyMiddleware,
  authMiddleware,
  authMiddlewareAllowNSE,
} from "@/middleware/auth";
import { devAuthMiddleware } from "@/middleware/devAuth";
import { lifecycleTestAuthMiddleware } from "@/middleware/lifecycleTestAuth";
import { assetRenewalLimiter } from "@/middleware/rateLimit";
import { agentsRouter } from "./agents/agents.router";
import { assetsRouter } from "./assets/assets.router";
import { lifecycleStatusHandler } from "./assets/handlers/lifecycle-status";
import { testLifecycleHandler } from "./assets/handlers/test-lifecycle";
import { attachmentsRouter } from "./attachments/attachments.router";
import { authRouter } from "./auth/auth.router";
import { devRouter } from "./dev/dev.router";
import { deviceRouter } from "./device/device.router";
import invitesV2Router from "./invites/invites.router";
import { notificationsRouter } from "./notifications/notifications.router";
import { webhookRouter } from "./notifications/webhook.router";

const v2Router = Router();

if (process.env.XMTP_ENV !== "production") {
  v2Router.use("/dev", devAuthMiddleware, devRouter);
}

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

v2Router.use("/assets", authMiddleware, assetRenewalLimiter, assetsRouter);
v2Router.use("/agents", authMiddleware, agentsRouter);
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
