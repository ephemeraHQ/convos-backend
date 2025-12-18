import { Router } from "express";
import { webhookAuthMiddleware } from "@/middleware/webhookAuth";
import { handleXmtpNotification } from "./webhook-handler";

const webhookRouter = Router();

// XMTP webhook handler (shared between v1 and v2)
webhookRouter.post(
  "/handle-notification",
  webhookAuthMiddleware,
  handleXmtpNotification,
);

export { webhookRouter };
