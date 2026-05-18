import { Router } from "express";
import { appleSsnHandler } from "./handlers/apple-ssn";

export const appleWebhookRouter = Router();

// Apple authenticates via the JWS signature, not via auth middleware.
// Keep /ssn for the iOS brief and /server-notifications for App Store Connect
// / PRD wording.
appleWebhookRouter.post("/ssn", appleSsnHandler);
appleWebhookRouter.post("/server-notifications", appleSsnHandler);
