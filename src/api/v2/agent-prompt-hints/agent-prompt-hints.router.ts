import { Router } from "express";
import {
  authOrAgentApiKeyAuth,
  optionalAuthOrAgentApiKeyAuth,
} from "@/middleware/agentAuth";
import { requireAccount } from "@/middleware/auth";
import { createHandler } from "./handlers/create";
import { deleteHandler } from "./handlers/delete";
import { listHandler } from "./handlers/list";
import { listAdminHandler } from "./handlers/list-admin";
import { patchHandler } from "./handlers/patch";
import { reorderHandler } from "./handlers/reorder";

export const agentPromptHintsRouter = Router();

// Public read, mirroring the agent-templates catalog reads. No credentials are
// required (anonymous callers get the published set so the maker's empty
// composer works pre-login); valid-but-bad credentials still 401 via
// optionalAuthOrAgentApiKeyAuth. Hints are global, so the handler ignores any
// resolved account identity. The shape ({ hints: string[] }) is the frozen iOS
// contract — do not change it.
agentPromptHintsRouter.get("/", optionalAuthOrAgentApiKeyAuth, listHandler);

// Admin write surface. Gated by the same two-layer model the agent-templates
// admin writes use: agent-key auth (X-Agent-API-Key) resolves the ADMIN account
// with isApiKeyListener, or a JWT account. Hints are global rows, so there is
// no ownership guard. Static admin paths (/admin, /reorder) register before the
// "/:id" wildcard so it doesn't capture them as ids.
agentPromptHintsRouter.get(
  "/admin",
  authOrAgentApiKeyAuth,
  requireAccount,
  listAdminHandler,
);
agentPromptHintsRouter.post(
  "/reorder",
  authOrAgentApiKeyAuth,
  requireAccount,
  reorderHandler,
);
agentPromptHintsRouter.post(
  "/",
  authOrAgentApiKeyAuth,
  requireAccount,
  createHandler,
);
agentPromptHintsRouter.patch(
  "/:id",
  authOrAgentApiKeyAuth,
  requireAccount,
  patchHandler,
);
agentPromptHintsRouter.delete(
  "/:id",
  authOrAgentApiKeyAuth,
  requireAccount,
  deleteHandler,
);
