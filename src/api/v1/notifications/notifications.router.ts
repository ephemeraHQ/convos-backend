import { Router } from "express";
import { registerInstallation } from "@/api/v1/notifications/handlers/register-installation";
import { subscribeToTopics } from "@/api/v1/notifications/handlers/subscribe-to-topics";
import { unregisterInstallation } from "@/api/v1/notifications/handlers/unregister-installation";
import { unsubscribeFromTopics } from "@/api/v1/notifications/handlers/unsubscribe-from-topics";

const notificationsRouter = Router();

notificationsRouter.post("/register", registerInstallation);
notificationsRouter.post("/subscribe", subscribeToTopics);
notificationsRouter.post("/unsubscribe", unsubscribeFromTopics);
notificationsRouter.delete(
  "/unregister/:xmtpInstallationId",
  unregisterInstallation,
);

export { notificationsRouter };
