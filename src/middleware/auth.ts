import type { NextFunction, Request, Response } from "express";
import { pathToRegexp } from "path-to-regexp";
import { isNotificationExtensionOnlyToken, verifyJwtToken } from "@/utils/jwt";

export const AUTH_HEADER = "X-Convos-AuthToken";
export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authToken = req.header(AUTH_HEADER);

  if (!authToken) {
    res.status(401).send();
    return;
  }

  try {
    // Verify JWT token and get payload
    const payload = await verifyJwtToken({ token: authToken });

    const isNotificationExtensionToken =
      isNotificationExtensionOnlyToken(payload);

    // Check if notification extension token is trying to access a restricted endpoint
    if (isNotificationExtensionToken) {
      // Use the full path from the v1 router perspective
      const fullPath = req.baseUrl + req.path;
      const matchedRoute = isNotificationExtensionAllowedRoute(
        req.method,
        fullPath,
      );

      if (!matchedRoute) {
        res.status(403).json({
          error:
            "Notification extension only tokens cannot access this endpoint",
        });
        return;
      }
    }

    // Set values for request handlers
    res.locals.xmtpId = payload.inboxId;
    res.locals.xmtpInstallationId = payload.xmtpInstallationId;

    next();
  } catch {
    res.status(401).send();
    return;
  }
};

// Routes that are accessible by notification extension only tokens
const NOTIFICATION_EXTENSION_ALLOWED_ROUTES = [
  // Auth check route
  { method: "GET", path: "/api/v1/auth-check" },

  // Invites routes
  { method: "GET", path: "/api/v1/invites/requests" },
  { method: "DELETE", path: "/api/v1/invites/requests/:requestId" },
  { method: "GET", path: "/api/v1/invites/:inviteId/with-group" },
  { method: "GET", path: "/api/v1/invites/:inviteId" },
  { method: "DELETE", path: "/api/v1/invites/:inviteId" },

  // Profiles routes
  { method: "GET", path: "/api/v1/profiles/search" },
  { method: "GET", path: "/api/v1/profiles/check/:username" },
  { method: "POST", path: "/api/v1/profiles/batch" },
  { method: "GET", path: "/api/v1/profiles/:xmtpId" }, // For getting profile by xmtp ID
].map((route) => ({
  ...route,
  regexp: pathToRegexp(route.path), // Pre-compile the regex for better performance
}));

export const isNotificationExtensionAllowedRoute = (
  method: string,
  path: string,
) => {
  return NOTIFICATION_EXTENSION_ALLOWED_ROUTES.some(
    (route) => route.method === method && route.regexp.regexp.test(path),
  );
};
