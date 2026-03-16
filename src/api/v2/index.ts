import { Router } from "express";
import { agentApiKeyAuth, authOrAgentApiKeyAuth } from "@/middleware/agentAuth";
import {
  appCheckOnlyMiddleware,
  authMiddleware,
  authMiddlewareAllowNSE,
} from "@/middleware/auth";
import { devAuthMiddleware } from "@/middleware/devAuth";
import { lifecycleTestAuthMiddleware } from "@/middleware/lifecycleTestAuth";
import { poolApiKeyAuth } from "@/middleware/poolAuth";
import {
  agentAssetLimiter,
  agentAssetPreAuthLimiter,
  agentJoinLimiter,
  assetRenewalLimiter,
  serviceProvisionLimiter,
} from "@/middleware/rateLimit";
import { agentsRouter } from "./agents/agents.router";
import { provisionRouter } from "./agents/provision/provision.router";
import { agentAssetsRouter } from "./agents/assets/agent-assets.router";
import { assetsRouter } from "./assets/assets.router";
import { lifecycleStatusHandler } from "./assets/handlers/lifecycle-status";
import { migrateTimestampsHandler } from "./assets/handlers/migrate-timestamps";
import { renewBatchHandler } from "./assets/handlers/renew-batch";
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
// One-time migration endpoint - remove after lifecycle rule is enabled
v2Router.post(
  "/assets/test/migrate-timestamps",
  lifecycleTestAuthMiddleware,
  migrateTimestampsHandler,
);

// Renew assets with either JWT auth (iOS clients) or agent API key auth
v2Router.post(
  "/assets/renew-batch",
  authOrAgentApiKeyAuth,
  assetRenewalLimiter,
  renewBatchHandler,
);

v2Router.use("/assets", authMiddleware, assetsRouter);

// Must be mounted before /agents to avoid being caught by /agents auth middleware
v2Router.use(
  "/agents/provision",
  serviceProvisionLimiter,
  poolApiKeyAuth,
  provisionRouter,
);
v2Router.use(
  "/agents/assets",
  agentAssetPreAuthLimiter,
  agentApiKeyAuth,
  agentAssetLimiter,
  agentAssetsRouter,
);
v2Router.use("/agents", agentJoinLimiter, authMiddleware, agentsRouter);
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
