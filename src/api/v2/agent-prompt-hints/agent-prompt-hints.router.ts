import { Router } from "express";
import {
  authOrAgentApiKeyAuth,
  optionalAuthOrAgentApiKeyAuth,
} from "@/middleware/agentAuth";
import { requireAccount, requireAdmin } from "@/middleware/auth";
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

// Admin write surface. Hints are global rows with no owner, so unlike the
// agent-templates writes (which fall back to an ownership check) there is
// nothing to scope a regular account to. Restrict to the admin identity with
// `requireAdmin`, matching how the templates admin writes gate privileged
// access: agent-key auth (X-Agent-API-Key) resolves the ADMIN account with
// isApiKeyListener, and the admin account's own JWT is accepted too. Static
// admin paths (/admin, /reorder) register before the "/:id" wildcard so it
// doesn't capture them as ids.
agentPromptHintsRouter.get(
  "/admin",
  authOrAgentApiKeyAuth,
  requireAccount,
  requireAdmin,
  listAdminHandler,
);
agentPromptHintsRouter.post(
  "/reorder",
  authOrAgentApiKeyAuth,
  requireAccount,
  requireAdmin,
  reorderHandler,
);
agentPromptHintsRouter.post(
  "/",
  authOrAgentApiKeyAuth,
  requireAccount,
  requireAdmin,
  createHandler,
);
agentPromptHintsRouter.patch(
  "/:id",
  authOrAgentApiKeyAuth,
  requireAccount,
  requireAdmin,
  patchHandler,
);
agentPromptHintsRouter.delete(
  "/:id",
  authOrAgentApiKeyAuth,
  requireAccount,
  requireAdmin,
  deleteHandler,
);
