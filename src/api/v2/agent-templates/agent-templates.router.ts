import { Router } from "express";
import {
  authOrAgentApiKeyAuth,
  optionalAuthOrAgentApiKeyAuth,
} from "@/middleware/agentAuth";
import { requireAccount } from "@/middleware/auth";
import { createHandler } from "./handlers/create";
import { deleteHandler } from "./handlers/delete";
import { detailHandler } from "./handlers/detail";
import { listHandler } from "./handlers/list";
import { patchHandler } from "./handlers/patch";
import { publishHandler } from "./handlers/publish";

export const agentTemplatesRouter = Router();

agentTemplatesRouter.get("/", optionalAuthOrAgentApiKeyAuth, listHandler);
agentTemplatesRouter.post(
  "/",
  authOrAgentApiKeyAuth,
  requireAccount,
  createHandler,
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
  optionalAuthOrAgentApiKeyAuth,
  detailHandler,
);
