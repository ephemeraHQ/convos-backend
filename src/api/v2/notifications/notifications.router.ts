import { Router } from "express";
import { subscribe } from "./handlers/subscribe";
import { unregister } from "./handlers/unregister";
import { unsubscribe } from "./handlers/unsubscribe";

const notificationsRouter = Router();

// Push notification management routes
// All routes require auth (AppCheck or JWT) - applied at mount point in v2/index.ts
notificationsRouter.post("/subscribe", subscribe);
notificationsRouter.post("/unsubscribe", unsubscribe);
notificationsRouter.delete("/unregister/:clientId", unregister);

export { notificationsRouter };
