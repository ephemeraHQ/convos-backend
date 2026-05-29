import type { NextFunction, Request, Response } from "express";
import { AppError } from "@/utils/errors";
import { verifyAppCheckToken } from "@/utils/firebase";
import { isNotificationExtensionOnlyToken, verifyJwtToken } from "@/utils/jwt";
import { getRuntimeConfig } from "@/utils/runtimeConfig";

export const AUTH_HEADER = "X-Convos-AuthToken";
export const APPCHECK_HEADER = "X-Firebase-AppCheck";

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
    await verifyAppCheckToken(appCheckToken);
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
// Uses full path (baseUrl + path) to avoid matching relative paths on other mounts.
//
// Patterns are anchored regular expressions (^/$). Exact-string paths in the
// old design didn't accommodate param routes like /unregister/:clientId, so
// the allowlist was upgraded to regex patterns when T14 added NSE-driven
// orphan cleanup. Keep this list TIGHT — every entry is an NSE-callable
// surface and needs to be justified as "what NSE legitimately needs from
// backend during a push processing or cleanup pass".
const NSE_ALLOWED_PATH_PATTERNS: RegExp[] = [
  /^\/api\/v2\/auth-check$/,
  // T14: NSE-driven orphan cleanup. When the NSE detects an installation
  // mismatch (push arrived for an installationId the current keychain
  // identity no longer owns), it calls DELETE /notifications/unregister/
  // :clientId to remove the stale mapping. Reduced privilege: even though
  // the path is reachable with NSE auth, the handler still uses
  // verifyDeviceOwnership against res.locals.deviceId (set from the NSE
  // JWT) so NSE can only delete clients belonging to its OWN device.
  /^\/api\/v2\/notifications\/unregister\/[^/]+$/,
];

function isNseAllowedPath(fullPath: string): boolean {
  return NSE_ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(fullPath));
}

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
      if (!isNseAllowedPath(fullPath)) {
        req.log.warn(
          { deviceId: payload.deviceId, path: fullPath },
          "NSE token rejected - path not in allowlist",
        );
        res.status(403).json({ error: "NSE tokens not allowed on this route" });
        return;
      }
    }

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

export const requireAccount = (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!res.locals.accountId) {
    res.status(403).json({ error: "Account required" });
    return;
  }
  next();
};
