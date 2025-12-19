import { Router } from "express";
import { webhookRouter } from "@/api/shared/notifications/webhook.router";
import { appCheckOnlyMiddleware, authMiddleware } from "@/middleware/auth";
import { attachmentsRouter } from "./attachments/attachments.router";
import { authRouter } from "./auth/auth.router";
import { deviceRouter } from "./device/device.router";
import invitesV2Router from "./invites/invites.router";
import { notificationsRouter } from "./notifications/notifications.router";

const v2Router = Router();

v2Router.use("/invites", invitesV2Router);
v2Router.use("/auth", authRouter);
v2Router.use("/device", appCheckOnlyMiddleware, deviceRouter);
v2Router.use("/attachments", authMiddleware, attachmentsRouter);
v2Router.use("/notifications/xmtp", webhookRouter);
v2Router.use("/notifications", authMiddleware, notificationsRouter);

// Auth check endpoint (AppCheck or JWT)
v2Router.get("/auth-check", authMiddleware, (req, res) => {
  res.status(200).json({
    success: true,
  });
});

export default v2Router;
