import { Router } from "express";
import { authMiddleware } from "@/middleware/auth";
import { handleNotification } from "./handlers/handle-notification";
import { registerInstallation } from "./handlers/register-installation";
import { subscribeToTopics } from "./handlers/subscribe-to-topics";
import { unregisterInstallation } from "./handlers/unregister-installation";
import { unsubscribeFromTopics } from "./handlers/unsubscribe-from-topics";

const notificationsRouter = Router();

// Define all routes
notificationsRouter.post("/register", authMiddleware, registerInstallation);
notificationsRouter.post("/subscribe", authMiddleware, subscribeToTopics);
notificationsRouter.post("/unsubscribe", authMiddleware, unsubscribeFromTopics);
notificationsRouter.delete(
  "/unregister/:installationId",
  authMiddleware,
  unregisterInstallation,
);

// Handle notifications from the Xmtp network
notificationsRouter.post(
  "/handle-notification",
  // TODO: Add auth middleware,
  handleNotification,
);

export default notificationsRouter;
