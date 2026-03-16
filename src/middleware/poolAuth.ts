import { createHash, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { AGENT_POOL_API_KEY } from "@/config";

const MIN_POOL_API_KEY_LENGTH = 32;

function constantTimeSecretCompare(
  provided: string,
  expected: string,
): boolean {
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export const poolApiKeyAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const expectedKey = AGENT_POOL_API_KEY.trim();

  if (!expectedKey) {
    res.status(503).json({ error: "Pool API key not configured" });
    return;
  }

  if (expectedKey.length < MIN_POOL_API_KEY_LENGTH) {
    req.log.error(
      {
        minLength: MIN_POOL_API_KEY_LENGTH,
        actualLength: expectedKey.length,
      },
      "AGENT_POOL_API_KEY too short - rejecting request",
    );
    res.status(503).json({ error: "Pool API key not configured" });
    return;
  }

  const authHeader = req.header("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedKey = match?.[1]?.trim() ?? "";

  if (!providedKey) {
    res.status(401).json({ error: "Invalid or missing pool API key" });
    return;
  }

  const valid = constantTimeSecretCompare(providedKey, expectedKey);
  if (!valid) {
    res.status(401).json({ error: "Invalid or missing pool API key" });
    return;
  }

  next();
};
