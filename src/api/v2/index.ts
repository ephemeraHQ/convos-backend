import { Router } from "express";
import { webhookRouter } from "@/api/shared/notifications/webhook.router";
import { authV2Middleware } from "@/middleware/v2/auth";
import { authRouter } from "./auth/auth.router";
import invitesV2Router from "./invites/invites.router";
import { notificationsRouter } from "./notifications/notifications.router";

const v2Router = Router();

v2Router.use("/invites", invitesV2Router);
v2Router.use("/auth", authRouter);
v2Router.use("/notifications", authV2Middleware, notificationsRouter);

// XMTP webhook (shared with v1)
v2Router.use("/notifications/xmtp", webhookRouter);

// Simple auth check endpoint (AppCheck or JWT)
v2Router.get("/auth-check", authV2Middleware, (req, res) => {
  res.status(200).json({
    success: true,
  });
});

export default v2Router;
