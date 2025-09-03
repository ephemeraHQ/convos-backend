import { Router } from "express";
import appConfigRouter from "@/api/v1/appConfig";
import authenticateRouter from "@/api/v1/authenticate";
import {
  notificationsRouter,
  xmtpNotificationsRouter,
} from "@/api/v1/notifications/notifications.router";
import publicProfilesRouter from "@/api/v1/profiles/profiles-public.router";
import profilesRouter from "@/api/v1/profiles/profiles.router";
import { authMiddleware } from "@/middleware/auth";
import attachmentsRouter from "./attachments";
import devicesRouter from "./devices/devices.router";
import initRouter from "./init/init.router";
import publicInvitesRouter from "./invites/invites-public.router";
import invitesRouter from "./invites/invites.router";
import walletsRouter from "./wallets/wallets.router";

const v1Router = Router();

// mount app config routes under /app-config
v1Router.use("/app-config", appConfigRouter);

// mount authenticate routes under /authenticate
v1Router.use("/authenticate", authenticateRouter);

// mount xmtp notification webhook (no auth middleware)
v1Router.use("/notifications/xmtp", xmtpNotificationsRouter);

// create and manage turnkey wallets/suborgs
v1Router.use("/wallets", walletsRouter);

// mount notifications routes under /notifications
v1Router.use("/notifications", authMiddleware, notificationsRouter);

// mount init routes under /init
v1Router.use("/init", authMiddleware, initRouter);

// (backward compatibility) mount init routes under /users
v1Router.use("/users", authMiddleware, initRouter);

// mount device routes under /devices
v1Router.use("/devices", authMiddleware, devicesRouter);

// mount public profile routes under /profiles/public
v1Router.use("/profiles/public", publicProfilesRouter);

// mount authenticated profile routes under /profiles
v1Router.use("/profiles", authMiddleware, profilesRouter);

// mount attachments routes under /attachments
v1Router.use("/attachments", authMiddleware, attachmentsRouter);

// mount public invite routes under /invites/public
v1Router.use("/invites/public", publicInvitesRouter);

// mount invites routes under /invites
v1Router.use("/invites", authMiddleware, invitesRouter);

// simple auth check endpoint
v1Router.get("/auth-check", authMiddleware, (req, res) => {
  res.status(200).json({
    success: true,
  });
});

export default v1Router;
