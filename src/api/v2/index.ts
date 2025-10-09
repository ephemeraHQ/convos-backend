import { Router } from "express";
import { webhookRouter } from "@/api/shared/notifications/webhook.router";
import { authRouter } from "./auth/auth.router";
import invitesV2Router from "./invites/invites.router";
import { notificationsRouter } from "./notifications/notifications.router";

const v2Router = Router();

v2Router.use("/invites", invitesV2Router);
v2Router.use("/auth", authRouter);
v2Router.use("/notifications", notificationsRouter);

// XMTP webhook (shared with v1)
v2Router.use("/notifications/xmtp", webhookRouter);

export default v2Router;
