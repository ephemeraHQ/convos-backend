import { Router } from "express";
import { requireAccount } from "@/middleware/auth";
import { getAgentPresignedUrlHandler } from "./handlers/get-presigned-url";

export const agentAssetsRouter = Router();

agentAssetsRouter.get(
  "/presigned",
  requireAccount,
  getAgentPresignedUrlHandler,
);
