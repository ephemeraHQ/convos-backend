import { Router } from "express";
import { webhookAuthMiddleware } from "@/middleware/webhookAuth";
import { handleXmtpNotification } from "./handlers/webhook";

const webhookRouter = Router();

// XMTP webhook handler
webhookRouter.post(
  "/handle-notification",
  webhookAuthMiddleware,
  handleXmtpNotification,
);

export { webhookRouter };
