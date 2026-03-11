import { Router } from "express";
import { getAgentPresignedUrlHandler } from "./handlers/get-presigned-url";

export const agentAssetsRouter = Router();

agentAssetsRouter.get("/presigned", getAgentPresignedUrlHandler);
