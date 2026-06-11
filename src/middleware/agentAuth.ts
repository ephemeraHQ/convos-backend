import { createHash, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { AGENT_ASSETS_API_KEY, COMPOSIO_EXEC_API_KEY } from "@/config";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { maskKeyPrefix } from "@/utils/mask";
import { authMiddleware } from "./auth";

export const AGENT_API_KEY_HEADER = "X-Agent-API-Key";
// Dedicated header for the Composio exec endpoint. The trusted worker's
// proxyComposioExec sets it; the generic convos.internal proxy never does, so a
// container that smuggles a request to /api/v2/composio/exec through the generic
// proxy cannot authenticate (it has no way to produce this secret).
export const COMPOSIO_EXEC_API_KEY_HEADER = "X-Composio-Exec-Key";
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
    req.log.error("agent_api_key.not_configured");
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
    req.log.warn({ reason: "missing" }, "agent_api_key.unauthorized");
    res.status(401).json({ error: "Invalid or missing agent API key" });
    return;
  }

  const valid = constantTimeSecretCompare(providedKey, expectedKey);
  if (!valid) {
    req.log.warn(
      { reason: "mismatch", providedPrefix: maskKeyPrefix(providedKey) },
      "agent_api_key.unauthorized",
    );
    res.status(401).json({ error: "Invalid or missing agent API key" });
    return;
  }

  next();
};

// ---------------------------------------------------------------------------
// Composio exec auth — separate secret, separate header (see header doc above)
// ---------------------------------------------------------------------------

let _composioExecApiKeyOverride: string | null | undefined = undefined;

function getComposioExecApiKey(): string {
  if (_composioExecApiKeyOverride !== undefined) {
    return (_composioExecApiKeyOverride ?? "").trim();
  }
  return COMPOSIO_EXEC_API_KEY.trim();
}

/** Override `COMPOSIO_EXEC_API_KEY` for tests (same contract as the agent-key
 *  override: string overrides, `null` simulates unset → 503, `undefined`
 *  clears). */
export function __setComposioExecApiKeyOverrideForTests(
  key: string | null | undefined,
): void {
  _composioExecApiKeyOverride = key;
}

/**
 * Authenticates POST /v2/composio/exec against COMPOSIO_EXEC_API_KEY via the
 * X-Composio-Exec-Key header. Deliberately distinct from agentApiKeyAuth: the
 * worker's generic convos.internal proxy injects the *agent* key for arbitrary
 * backend paths, so reusing it here would let a container smuggle an exec call
 * (with forged identity headers) through that proxy. This secret lives only in
 * the worker and is set only by proxyComposioExec.
 */
export const composioExecAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const expectedKey = getComposioExecApiKey();

  if (!expectedKey || expectedKey.length < MIN_AGENT_API_KEY_LENGTH) {
    req.log.error("composio_exec_api_key.not_configured");
    res.status(503).json({ error: "Composio exec API key not configured" });
    return;
  }

  const providedKey = req.header(COMPOSIO_EXEC_API_KEY_HEADER)?.trim() ?? "";
  if (!providedKey) {
    req.log.warn({ reason: "missing" }, "composio_exec_api_key.unauthorized");
    res.status(401).json({ error: "Invalid or missing Composio exec key" });
    return;
  }

  if (!constantTimeSecretCompare(providedKey, expectedKey)) {
    req.log.warn(
      { reason: "mismatch", providedPrefix: maskKeyPrefix(providedKey) },
      "composio_exec_api_key.unauthorized",
    );
    res.status(401).json({ error: "Invalid or missing Composio exec key" });
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

/**
 * Optional auth middleware for endpoints that should be reachable
 * without credentials but still pick up account context when it's
 * provided.
 *
 * Behaviour:
 *   - Auth header (X-Agent-API-Key OR X-Convos-AuthToken) present →
 *     delegate to `authOrAgentApiKeyAuth` (same shape as today, sets
 *     `res.locals.accountId` and `res.locals.isApiKeyListener`).
 *   - No auth header → skip auth entirely. `res.locals.accountId`
 *     remains `undefined`; downstream handlers branch on that to
 *     return the public/anonymous view.
 *   - Auth header present but INVALID → 401. Presenting credentials
 *     is opt-in; if you opt in, they have to be valid.
 *
 * Used by the agent-templates list/detail/generation-{post,status}
 * endpoints. Write endpoints (POST /, PATCH, DELETE, /publish) stay
 * on `authOrAgentApiKeyAuth + requireAccount`.
 */
export const optionalAuthOrAgentApiKeyAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Check presence on the RAW header, not on the trimmed value. A blank
  // header (`X-Convos-AuthToken: "   "`) is still an attempt to
  // authenticate — fall through to the strict auth path so it 401s,
  // matching the "present but invalid → 401" contract documented below.
  const providedAgentApiKey = req.header(AGENT_API_KEY_HEADER);
  const providedAuthToken = req.header("X-Convos-AuthToken");

  if (providedAgentApiKey === undefined && providedAuthToken === undefined) {
    next();
    return;
  }

  await authOrAgentApiKeyAuth(req, res, next);
};
