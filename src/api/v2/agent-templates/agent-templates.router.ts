import { Router } from "express";
import { authOrAgentApiKeyAuth } from "@/middleware/agentAuth";
import { createHandler } from "./handlers/create";
import { deleteHandler } from "./handlers/delete";
import { detailHandler } from "./handlers/detail";
import { generateTemplateHandler } from "./handlers/generate-template";
import { listHandler } from "./handlers/list";
import { patchHandler } from "./handlers/patch";
import { publishHandler } from "./handlers/publish";

export const agentTemplatesRouter = Router();

agentTemplatesRouter.get("/", listHandler);
agentTemplatesRouter.post("/", authOrAgentApiKeyAuth, createHandler);
agentTemplatesRouter.post(
  "/generate",
  authOrAgentApiKeyAuth,
  generateTemplateHandler,
);
agentTemplatesRouter.patch("/:id", authOrAgentApiKeyAuth, patchHandler);
agentTemplatesRouter.delete("/:id", authOrAgentApiKeyAuth, deleteHandler);
agentTemplatesRouter.post(
  "/:id/publish",
  authOrAgentApiKeyAuth,
  publishHandler,
);
agentTemplatesRouter.get("/:idOrHashedSlug", detailHandler);
