import { Router } from "express";
import { authOrAgentApiKeyAuth } from "@/middleware/agentAuth";
import { requireAccount } from "@/middleware/auth";
import { createHandler } from "./handlers/create";
import { deleteHandler } from "./handlers/delete";
import { detailHandler } from "./handlers/detail";
import { generationsGetHandler } from "./handlers/generations-get";
import { generationsPostHandler } from "./handlers/generations-post";
import { listHandler } from "./handlers/list";
import { patchHandler } from "./handlers/patch";
import { publishHandler } from "./handlers/publish";

export const agentTemplatesRouter = Router();

agentTemplatesRouter.get(
  "/",
  authOrAgentApiKeyAuth,
  requireAccount,
  listHandler,
);
agentTemplatesRouter.post(
  "/",
  authOrAgentApiKeyAuth,
  requireAccount,
  createHandler,
);

// Async generation surface — must be mounted before /:idOrHashedSlug so the
// wildcard doesn't capture "generations" as a slug-or-id.
agentTemplatesRouter.post(
  "/generations",
  authOrAgentApiKeyAuth,
  requireAccount,
  generationsPostHandler,
);
agentTemplatesRouter.get(
  "/generations/:generationId",
  authOrAgentApiKeyAuth,
  requireAccount,
  generationsGetHandler,
);

agentTemplatesRouter.patch(
  "/:id",
  authOrAgentApiKeyAuth,
  requireAccount,
  patchHandler,
);
agentTemplatesRouter.delete(
  "/:id",
  authOrAgentApiKeyAuth,
  requireAccount,
  deleteHandler,
);
agentTemplatesRouter.post(
  "/:id/publish",
  authOrAgentApiKeyAuth,
  requireAccount,
  publishHandler,
);
agentTemplatesRouter.get(
  "/:idOrHashedSlug",
  authOrAgentApiKeyAuth,
  requireAccount,
  detailHandler,
);
