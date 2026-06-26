import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { XMTP_ENV } from "@/config";
import { agentApiKeyAuth, authOrAgentApiKeyAuth } from "@/middleware/agentAuth";
import { deleteAgentVariantHandler } from "./handlers/delete";
import { listAgentVariantsHandler } from "./handlers/list";
import { upsertAgentVariantHandler } from "./handlers/upsert";

export const agentVariantsRouter = Router();

// Variants are a dev-network-only feature. The write routes 404 on prod even if
// the registry token were somehow configured there — defense in depth on top of
// the token being unset. (The GET returns [] off-dev instead of 404 so the
// app's picker gets the documented empty-list contract.)
function requireDevBackend(_req: Request, res: Response, next: NextFunction) {
  if (XMTP_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

// Read by the dev app picker (a signed-in client's JWT) and by the
// convos-assistants variant-sweep CI (the agent API key) — authOrAgentApiKeyAuth
// accepts either. Non-sensitive dev-only data, and the handler returns [] off-dev.
agentVariantsRouter.get("/", authOrAgentApiKeyAuth, listAgentVariantsHandler);

// Written only by the convos-assistants variant CI, authenticating with the
// agent API key (X-Agent-API-Key) — the same machine→backend credential the
// worker uses. The container can't smuggle a write through the worker's
// convos.internal proxy: that path is denylisted in the proxy (outbound.ts).
// requireDevBackend runs first so prod 404s before auth even evaluates.
agentVariantsRouter.post(
  "/",
  requireDevBackend,
  agentApiKeyAuth,
  upsertAgentVariantHandler,
);
agentVariantsRouter.delete(
  "/:slug",
  requireDevBackend,
  agentApiKeyAuth,
  deleteAgentVariantHandler,
);
