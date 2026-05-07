import { Router } from "express";
import { detailHandler } from "./handlers/detail";
import { listHandler } from "./handlers/list";

export const agentTemplatesRouter = Router();

agentTemplatesRouter.get("/", listHandler);
agentTemplatesRouter.get("/:idOrHashedSlug", detailHandler);
