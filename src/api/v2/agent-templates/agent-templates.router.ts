import { Router } from "express";
import { listHandler } from "./handlers/list";

export const agentTemplatesRouter = Router();

agentTemplatesRouter.get("/", listHandler);
