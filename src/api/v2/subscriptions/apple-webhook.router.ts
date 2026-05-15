import { Router } from "express";
import { appleSsnHandler } from "./handlers/apple-ssn";

export const appleWebhookRouter = Router();

// Apple authenticates via the JWS signature, not via auth middleware.
// Path matches the iOS brief: POST /v2/webhooks/apple/ssn.
appleWebhookRouter.post("/ssn", appleSsnHandler);
