import { createHash, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { AGENT_ASSETS_API_KEY } from "@/config";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { authMiddleware } from "./auth";

export const AGENT_API_KEY_HEADER = "X-Agent-API-Key";
const MIN_AGENT_API_KEY_LENGTH = 32;

// ---------------------------------------------------------------------------
// Config-backed accessor (with test-only override seam)
// ---------------------------------------------------------------------------

let _agentAssetsApiKeyOverride: string | null | undefined = undefined;

function getAgentAssetsApiKey(): string {
  // `undefined` ⇒ fall through to config; `null`/empty string ⇒ explicitly
  // unset (forces 503 path). Tests use this seam instead of mutating
  // process.env at runtime so the cached config value isn't bypassed.
  if (_agentAssetsApiKeyOverride !== undefined) {
    return (_agentAssetsApiKeyOverride ?? "").trim();
  }
  return AGENT_ASSETS_API_KEY.trim();
}

/** Override `AGENT_ASSETS_API_KEY` for tests.
 *  - Pass a string to override.
 *  - Pass `null` to simulate "key unset" (forces 503).
 *  - Pass `undefined` to clear the override and fall back to config. */
export function __setAgentAssetsApiKeyOverrideForTests(
  key: string | null | undefined,
): void {
  _agentAssetsApiKeyOverride = key;
}

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
  const expectedKey = getAgentAssetsApiKey();

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
    // Wrap next so we can set identity flags after successful API key auth
    agentApiKeyAuth(req, res, () => {
      res.locals.accountId = ADMIN_ACCOUNT_ID;
      res.locals.isApiKeyListener = true;
      next();
    });
    return;
  }

  req.log.debug("Attempting JWT authentication");
  await authMiddleware(req, res, next);
};
