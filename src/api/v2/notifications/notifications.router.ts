import { Router } from "express";
import { register } from "./handlers/register";
import { subscribe } from "./handlers/subscribe";
import { unregister } from "./handlers/unregister";
import { unsubscribe } from "./handlers/unsubscribe";

const notificationsRouter = Router();

// All routes require auth (AppCheck or JWT) - applied at mount point in v2/index.ts
notificationsRouter.post("/register", register);
notificationsRouter.post("/subscribe", subscribe);
notificationsRouter.post("/unsubscribe", unsubscribe);
notificationsRouter.delete("/unregister/:clientId", unregister);

export { notificationsRouter };
