import { Router } from "express";
import { handleXmtpNotification } from "./handlers/handle-xmtp-notification";

// Router for authenticated notification endpoints
const xmtpNotificationsRouter = Router();

xmtpNotificationsRouter.post("/handle-notification", handleXmtpNotification);

export default xmtpNotificationsRouter;
