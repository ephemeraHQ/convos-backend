import { Router } from "express";
import { authV2Middleware } from "@/middleware/v2/auth";
import { register } from "./handlers/register";
import { subscribe } from "./handlers/subscribe";
import { unsubscribe } from "./handlers/unsubscribe";
import { unregister } from "./handlers/unregister";

const notificationsRouter = Router();

// All routes require auth (AppCheck or JWT)
notificationsRouter.post("/register", authV2Middleware, register);
notificationsRouter.post("/subscribe", authV2Middleware, subscribe);
notificationsRouter.post("/unsubscribe", authV2Middleware, unsubscribe);
notificationsRouter.delete(
  "/unregister/:clientIdentifier",
  authV2Middleware,
  unregister,
);

export { notificationsRouter };
