import { Router } from "express";
import { provisionEmailHandler } from "./handlers/provision-email";
import { provisionSmsHandler } from "./handlers/provision-sms";
import { serviceStatusHandler } from "./handlers/service-status";

export const provisionRouter = Router();

provisionRouter.post("/email", provisionEmailHandler);
provisionRouter.post("/sms", provisionSmsHandler);
provisionRouter.get("/status", serviceStatusHandler);
