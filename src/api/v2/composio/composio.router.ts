import { Router } from "express";
import { execHandler } from "./handlers/exec";

// Agent-facing Composio surface. Mounted under composioExecAuth (see v2/index).
// The dedicated exec key only authenticates the caller; per-account
// authorization happens in the handler against the trusted identity + grant
// store.
export const composioRouter = Router();

composioRouter.post("/exec", execHandler);
