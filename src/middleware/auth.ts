import type { NextFunction, Request, Response } from "express";
import { verifyAppCheckToken } from "@/utils/firebase";
import { verifyJwtToken } from "@/utils/jwt";

export const AUTH_HEADER = "X-Convos-AuthToken";
export const APPCHECK_HEADER = "X-Firebase-AppCheck";

export const appCheckOnlyMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
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
 * Used for all authenticated endpoints except device registration and token exchange.
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
    res.locals.jwtMetadata = payload.metadata;
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
    res.status(401).json({ error: "Invalid auth token" });
    return;
  }
};
