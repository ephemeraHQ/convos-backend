import { Router } from "express";
import { optionalAuthOrAgentApiKeyAuth } from "@/middleware/agentAuth";
import { listHandler } from "./handlers/list";

export const agentPromptHintsRouter = Router();

// Public read, mirroring the agent-templates catalog reads. No credentials are
// required (anonymous callers get the published set so the maker's empty
// composer works pre-login); valid-but-bad credentials still 401 via
// optionalAuthOrAgentApiKeyAuth. Hints are global, so the handler ignores any
// resolved account identity.
agentPromptHintsRouter.get("/", optionalAuthOrAgentApiKeyAuth, listHandler);
