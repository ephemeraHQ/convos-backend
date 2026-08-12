import { createHash, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { maskKeyPrefix } from "@/utils/mask";

/**
 * Per-PR preview access gate (CON-825).
 *
 * Preview bundles are publicly resolvable (`https://pr-<N>.dev.convos.xyz`),
 * so when `PREVIEW=1` every request must present the bundle's token in
 * `X-Preview-Token`. The token is derived per PR as HMAC(master, pr_number) by
 * CI and injected as `PREVIEW_TOKEN`; deriving it is not this module's job.
 *
 * `/healthcheck` is the only exemption, and it is exact — the ALB target-group
 * probe and the ECS container health check both hit `/healthcheck` with no
 * headers (the container probe appends `?container=true`, which `req.path`
 * excludes). The `/healthcheck/details` subtree is NOT exempt: it reports
 * database and notification-service state.
 *
 * Machine callers need the token too. The assistants worker reaches the backend
 * through the convos.internal proxy, which injects `X-Agent-API-Key`; the same
 * pipeline deploys that worker per PR, so it gets `PREVIEW_TOKEN` and attaches
 * it. Exempting the agent-key paths instead would punch the hole in exactly the
 * most powerful routes.
 *
 * Env is read per request rather than cached through `src/config.ts` on
 * purpose: `config.ts` throws at import for everything it validates, and each
 * constant added there widens the boot contract. This follows the existing
 * `bearerTokenAuth` / `lifecycleTestAuth` shape; the constant-time comparison
 * follows `agentAuth`.
 */

export const PREVIEW_TOKEN_HEADER = "X-Preview-Token";

/** Exact paths that bypass the gate. Prefix matching is deliberately absent. */
export const PREVIEW_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/healthcheck",
]);

export const MIN_PREVIEW_TOKEN_LENGTH = 32;

/** True only for the exact string "1" — nothing else enables the gate. */
export const isPreviewMode = (): boolean => process.env.PREVIEW === "1";

function constantTimeSecretCompare(
  provided: string,
  expected: string,
): boolean {
  // Compare fixed-length SHA-256 digests so the comparison neither leaks the
  // secret's length nor throws on a length mismatch. Same helper shape as
  // src/middleware/agentAuth.ts.
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export const previewTokenMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!isPreviewMode()) {
    next();
    return;
  }

  // `req.path` is the pathname only — query strings are excluded, and the
  // middleware is mounted at the root so `req.baseUrl` is empty.
  if (PREVIEW_EXEMPT_PATHS.has(req.path)) {
    next();
    return;
  }

  const expectedToken = process.env.PREVIEW_TOKEN?.trim() ?? "";
  if (expectedToken.length < MIN_PREVIEW_TOKEN_LENGTH) {
    // Fail closed: a preview that is supposed to be gated must not serve
    // traffic just because its token failed to arrive.
    req.log.error(
      {
        minLength: MIN_PREVIEW_TOKEN_LENGTH,
        actualLength: expectedToken.length,
      },
      "preview_token.not_configured",
    );
    res.status(503).json({ error: "Preview token not configured" });
    return;
  }

  const providedToken = req.header(PREVIEW_TOKEN_HEADER)?.trim() ?? "";
  if (!providedToken) {
    req.log.warn({ reason: "missing" }, "preview_token.unauthorized");
    res.status(401).json({ error: "Invalid or missing preview token" });
    return;
  }

  if (!constantTimeSecretCompare(providedToken, expectedToken)) {
    req.log.warn(
      { reason: "mismatch", providedPrefix: maskKeyPrefix(providedToken) },
      "preview_token.unauthorized",
    );
    res.status(401).json({ error: "Invalid or missing preview token" });
    return;
  }

  next();
};
