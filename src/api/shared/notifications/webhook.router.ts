import { Router } from "express";
import { xmtpWebhookAuthMiddleware } from "@/middleware/xmtpWebhookAuth";
import { handleXmtpNotification } from "./webhook-handler";

const webhookRouter = Router();

// XMTP webhook handler (shared between v1 and v2)
webhookRouter.post(
  "/handle-notification",
  xmtpWebhookAuthMiddleware,
  handleXmtpNotification,
);

export { webhookRouter };
