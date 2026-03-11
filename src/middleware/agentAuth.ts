import { createHash, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { AGENT_ASSETS_API_KEY } from "@/config";
import { authMiddleware } from "./auth";

export const AGENT_API_KEY_HEADER = "X-Agent-API-Key";
const MIN_AGENT_API_KEY_LENGTH = 32;

function constantTimeSecretCompare(
  provided: string,
  expected: string,
): boolean {
  // Compare fixed-length SHA-256 digests to avoid leaking secret length.
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

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

  if (expectedKey.length < MIN_AGENT_API_KEY_LENGTH) {
    req.log.error(
      {
        minLength: MIN_AGENT_API_KEY_LENGTH,
        actualLength: expectedKey.length,
      },
      "AGENT_ASSETS_API_KEY too short - rejecting request",
    );
    res.status(503).json({ error: "Agent assets API key not configured" });
    return;
  }

  const providedKey = req.header(AGENT_API_KEY_HEADER)?.trim() ?? "";
  if (!providedKey) {
    res.status(401).json({ error: "Invalid or missing agent API key" });
    return;
  }

  const valid = constantTimeSecretCompare(providedKey, expectedKey);
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
    req.log.debug("Attempting agent API key authentication");
    agentApiKeyAuth(req, res, next);
    return;
  }

  req.log.debug("Attempting JWT authentication");
  await authMiddleware(req, res, next);
};
