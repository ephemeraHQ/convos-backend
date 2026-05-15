import { Router } from "express";
import { agentApiKeyAuth } from "@/middleware/agentAuth";
import { check } from "./handlers/check";

const creditsRouter = Router();

creditsRouter.post("/check", agentApiKeyAuth, check);

export { creditsRouter };
