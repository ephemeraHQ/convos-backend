import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { AGENT_ASSETS_API_KEY } from "@/config";
import { authMiddleware } from "./auth";

export const AGENT_API_KEY_HEADER = "X-Agent-API-Key";

export const agentApiKeyAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const expectedKey = AGENT_ASSETS_API_KEY.trim();
  if (!expectedKey) {
    res.status(503).json({ error: "Agent assets API key not configured" });
    return;
  }

  const providedKey = req.header(AGENT_API_KEY_HEADER)?.trim() ?? "";
  if (!providedKey) {
    res.status(401).json({ error: "Invalid or missing agent API key" });
    return;
  }

  const provided = Buffer.from(providedKey, "utf8");
  const expected = Buffer.from(expectedKey, "utf8");
  const valid =
    provided.length === expected.length && timingSafeEqual(provided, expected);

  if (!valid) {
    res.status(401).json({ error: "Invalid or missing agent API key" });
    return;
  }

  next();
};

export const authOrAgentApiKeyAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const providedAgentApiKey = req.header(AGENT_API_KEY_HEADER)?.trim();

  if (providedAgentApiKey) {
    agentApiKeyAuth(req, res, next);
    return;
  }

  await authMiddleware(req, res, next);
};
