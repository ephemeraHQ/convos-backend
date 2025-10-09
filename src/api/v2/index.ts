import { Router } from "express";
import invitesV2Router from "./invites/invites.router";
import { authRouter } from "./auth/auth.router";
import { notificationsRouter } from "./notifications/notifications.router";

const v2Router = Router();

v2Router.use("/invites", invitesV2Router);
v2Router.use("/auth", authRouter);
v2Router.use("/notifications", notificationsRouter);

export default v2Router;
