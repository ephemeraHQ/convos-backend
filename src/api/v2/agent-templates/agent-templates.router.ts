import { Router } from "express";
import { authOrAgentApiKeyAuth } from "@/middleware/agentAuth";
import { createHandler } from "./handlers/create";
import { deleteHandler } from "./handlers/delete";
import { detailHandler } from "./handlers/detail";
import { listHandler } from "./handlers/list";
import { patchHandler } from "./handlers/patch";

export const agentTemplatesRouter = Router();

agentTemplatesRouter.get("/", listHandler);
agentTemplatesRouter.post("/", authOrAgentApiKeyAuth, createHandler);
agentTemplatesRouter.patch("/:id", authOrAgentApiKeyAuth, patchHandler);
agentTemplatesRouter.delete("/:id", authOrAgentApiKeyAuth, deleteHandler);
agentTemplatesRouter.get("/:idOrHashedSlug", detailHandler);
