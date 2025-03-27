import { Router } from "express";
import { registerInstallation } from "./handlers/register-installation";
import { subscribeToTopics } from "./handlers/subscribe-to-topics";
import { unregisterInstallation } from "./handlers/unregister-installation";
import { unsubscribeFromTopics } from "./handlers/unsubscribe-from-topics";

const notificationsRouter = Router();

notificationsRouter.post("/register", registerInstallation);
notificationsRouter.post("/subscribe", subscribeToTopics);
notificationsRouter.post("/unsubscribe", unsubscribeFromTopics);
notificationsRouter.delete(
  "/unregister/:installationId",
  unregisterInstallation,
);

export default notificationsRouter;
