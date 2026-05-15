import { Router } from "express";
import { agentApiKeyAuth } from "@/middleware/agentAuth";
import { check } from "./handlers/check";
import { consume } from "./handlers/consume";

const creditsRouter = Router();

creditsRouter.post("/check", agentApiKeyAuth, check);
creditsRouter.post("/consume", agentApiKeyAuth, consume);

export { creditsRouter };
