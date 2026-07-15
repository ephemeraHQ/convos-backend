import type { NextFunction, Request, Response } from "express";
import { stampAuthActivity } from "@/accounts/auth-activity";
import { accountIdSchema } from "@/utils/account-id";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { AppError } from "@/utils/errors";
import { verifyAppCheckToken } from "@/utils/firebase";
import { isNotificationExtensionOnlyToken, verifyJwtToken } from "@/utils/jwt";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";
import { getRuntimeConfig } from "@/utils/runtimeConfig";

export const AUTH_HEADER = "X-Convos-AuthToken";
export const APPCHECK_HEADER = "X-Firebase-AppCheck";

/**
 * The single deleted-account carve-out: DELETE /v2/accounts/me accepts a
 * validly-signed, unexpired token whose account is already gone, so an
 * idempotent deletion retry can re-read its stored record. Every other
 * accountId-bearing request is fenced below.
 */
const isDeleteReplayCarveOut = (req: Request): boolean => {
  if (req.method !== "DELETE") return false;
  const fullPath = `${req.baseUrl}${req.path}`.replace(/\/+$/, "");
  return fullPath === "/api/v2/accounts/me";
};

/**
 * Deletion fence, applied inside JWT authentication itself so no route
 * registration can forget it: a JWT carrying an accountId claim is only
 * accepted while the Account row still exists. A deleted account's
 * unexpired token gets a generic 401 on every route (never a
 * deletion-specific signal — the mint-path 410 is the only confirmation
 * channel). No positive caching: fail-closed means every check hits the
 * database. Returns false after writing the response when the request must
 * not proceed.
 *
 * Live requests also stamp lastAuthAt (throttled, fire-and-forget): the
 * claim contest window treats any authenticated act as a veto.
 */
type VerifiedJwtPayload = Awaited<ReturnType<typeof verifyJwtToken>>;

const enforceLiveAccountClaim = async (
  req: Request,
  res: Response,
  payload: VerifiedJwtPayload,
): Promise<boolean> => {
  if (!payload.accountId || isDeleteReplayCarveOut(req)) return true;
  if (!accountIdSchema.safeParse(payload.accountId).success) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  const account = await prisma.account.findUnique({
    where: { id: payload.accountId },
    select: { id: true, lastAuthAt: true },
  });
  if (!account) {
    req.log.warn({ deviceId: payload.deviceId }, "auth.fence.account_not_live");
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (!isNotificationExtensionOnlyToken(payload)) {
    // Awaited: the contest-window veto depends on this stamp being durable
    // before the request proceeds (see stampAuthActivity).
    await stampAuthActivity(account.id, account.lastAuthAt);
  }
  return true;
};

export const appCheckOnlyMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const appAttestEnabled =
    (await getRuntimeConfig("app_attest_enabled", "true")) === "true";

  if (!appAttestEnabled) {
    req.log.warn("AppCheck bypassed - disabled via runtime config");
    next();
    return;
  }

  const appCheckToken = req.header(APPCHECK_HEADER);

  req.log.info(
    {
      path: req.path,
      method: req.method,
      hasAppCheck: !!appCheckToken,
    },
    "AppCheck-only middleware - incoming request",
  );

  if (!appCheckToken) {
    req.log.warn("No AppCheck token provided");
    res.status(401).json({ error: "Missing AppCheck token" });
    return;
  }

  try {
    const appId = await verifyAppCheckToken(appCheckToken);
    res.locals.appCheckAppId = appId;
    req.log.info("AppCheck verification successful");
    next();
  } catch (error) {
    req.log.error({ error }, "AppCheck verification failed");
    res.status(401).json({ error: "Invalid AppCheck token" });
    return;
  }
};

/**
 * JWT authentication middleware.
 * Rejects NSE tokens by default - use authMiddlewareAllowNSE for diagnostic endpoints.
 */
export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authToken = req.header(AUTH_HEADER);

  req.log.info(
    {
      path: req.path,
      method: req.method,
      hasAuthToken: !!authToken,
    },
    "Auth middleware - incoming request",
  );

  if (!authToken) {
    req.log.warn("No JWT token provided");
    res.status(401).json({ error: "Missing auth token" });
    return;
  }

  try {
    const payload = await verifyJwtToken({ token: authToken });
    res.locals.deviceId = payload.deviceId;
    res.locals.accountId = payload.accountId;
    res.locals.jwtMetadata = payload.metadata;

    // Reject NSE tokens - they can only use auth-check endpoint
    if (isNotificationExtensionOnlyToken(payload)) {
      req.log.warn(
        { deviceId: payload.deviceId },
        "NSE token rejected - not allowed on this route",
      );
      res.status(403).json({ error: "NSE tokens not allowed on this route" });
      return;
    }

    // Deletion fence: an accountId claim is only honored while the account
    // row exists (fail-closed on every route, delete-replay carve-out
    // excepted).
    if (!(await enforceLiveAccountClaim(req, res, payload))) return;

    req.log.info({ deviceId: payload.deviceId }, "JWT verification successful");
    next();
  } catch (error) {
    req.log.error({ error }, "JWT verification failed");
    if (error instanceof AppError && error.statusCode >= 500) {
      res.status(500).json({ error: "Internal server error" });
      return;
    }
    res.status(401).json({ error: "Invalid auth token" });
    return;
  }
};

// Defense in depth: NSE tokens can only access these paths even if middleware is misapplied
// Uses full path (baseUrl + path) to avoid matching relative paths on other mounts
const NSE_ALLOWED_PATHS = ["/api/v2/auth-check"];

/**
 * JWT authentication middleware that allows NSE tokens.
 * Used for diagnostic endpoints like auth-check.
 *
 * NOTE: NSE tokens are restricted to paths in NSE_ALLOWED_PATHS as defense in depth.
 */
export const authMiddlewareAllowNSE = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authToken = req.header(AUTH_HEADER);

  req.log.info(
    {
      path: req.path,
      method: req.method,
      hasAuthToken: !!authToken,
    },
    "Auth middleware (allow NSE) - incoming request",
  );

  if (!authToken) {
    req.log.warn("No JWT token provided");
    res.status(401).json({ error: "Missing auth token" });
    return;
  }

  try {
    const payload = await verifyJwtToken({ token: authToken });
    res.locals.deviceId = payload.deviceId;
    res.locals.accountId = payload.accountId;
    res.locals.jwtMetadata = payload.metadata;

    // Defense in depth: restrict NSE tokens to whitelisted paths
    if (isNotificationExtensionOnlyToken(payload)) {
      const fullPath = req.baseUrl + req.path;
      if (!NSE_ALLOWED_PATHS.includes(fullPath)) {
        req.log.warn(
          { deviceId: payload.deviceId, path: fullPath },
          "NSE token rejected - path not in allowlist",
        );
        res.status(403).json({ error: "NSE tokens not allowed on this route" });
        return;
      }
    }

    // Deletion fence: same fail-closed rule as authMiddleware — a deleted
    // account's unexpired token must not pass even the diagnostic
    // auth-check.
    if (!(await enforceLiveAccountClaim(req, res, payload))) return;

    req.log.info(
      {
        deviceId: payload.deviceId,
        isNSEOnly: payload.metadata?.notificationExtensionOnly,
      },
      "JWT verification successful",
    );
    next();
  } catch (error) {
    req.log.error({ error }, "JWT verification failed");
    if (error instanceof AppError && error.statusCode >= 500) {
      res.status(500).json({ error: "Internal server error" });
      return;
    }
    res.status(401).json({ error: "Invalid auth token" });
    return;
  }
};

export const requireAccount = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!accountIdSchema.safeParse(res.locals.accountId).success) {
    ((req as { log?: Request["log"] }).log ?? logger).warn(
      { accountIdPresent: res.locals.accountId !== undefined },
      "requireAccount rejected request",
    );
    res.status(403).json({ error: "Account required" });
    return;
  }
  // Fail closed: the JWT claim alone is not enough — the account row must
  // still exist. A deleted account holding an unexpired token gets a generic
  // 401 (never a deletion-specific signal: the mint-path 410 is the only
  // confirmation channel). Single indexed PK lookup per request.
  try {
    const account = await prisma.account.findUnique({
      where: { id: res.locals.accountId as string },
      select: { id: true },
    });
    if (!account) {
      ((req as { log?: Request["log"] }).log ?? logger).warn(
        { deviceId: res.locals.deviceId },
        "auth.require_account.missing_account",
      );
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  } catch (error) {
    ((req as { log?: Request["log"] }).log ?? logger).error(
      { error },
      "auth.require_account.lookup_failed",
    );
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  next();
};

/**
 * Restricts a route to the admin identity. Mirrors how the agent-templates
 * admin writes restrict privileged access: the only non-owner allowed to write
 * is the agent-API-key caller (`isApiKeyListener`), which resolves to
 * `ADMIN_ACCOUNT_ID`. The admin account authenticating via its own JWT (the
 * identity the agent-templates admin tests use) is accepted too, so the gate
 * holds whichever path the admin uses. Layer this after `requireAccount`.
 */
export const requireAdmin = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const isApiKeyListener = res.locals.isApiKeyListener === true;
  const isAdminAccount = res.locals.accountId === ADMIN_ACCOUNT_ID;
  if (!isApiKeyListener && !isAdminAccount) {
    ((req as { log?: Request["log"] }).log ?? logger).warn(
      { isApiKeyListener },
      "requireAdmin rejected request",
    );
    res.status(403).json({ error: "Admin required" });
    return;
  }
  next();
};
