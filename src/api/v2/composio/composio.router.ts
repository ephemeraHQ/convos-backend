import { Router } from "express";
import { execHandler } from "./handlers/exec";

// Agent-facing Composio surface. Mounted under agentApiKeyAuth (see v2/index).
// The shared agent key only authenticates the caller; per-account authorization
// happens in the handler against the trusted identity + grant store.
export const composioRouter = Router();

composioRouter.post("/exec", execHandler);
