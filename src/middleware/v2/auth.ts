import type { NextFunction, Request, Response } from "express";
import { verifyAppCheckToken } from "@/utils/firebase";
import { verifyV2JwtToken } from "@/utils/jwt";

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
  }
};

export const authV2Middleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const appCheckToken = req.header(APPCHECK_HEADER);
  const authToken = req.header(AUTH_HEADER);

  req.log.info(
    {
      path: req.path,
      method: req.method,
      hasAppCheck: !!appCheckToken,
      hasAuthToken: !!authToken,
    },
    "V2 auth middleware - incoming request",
  );

  // Try AppCheck first (main app)
  if (appCheckToken) {
    try {
      await verifyAppCheckToken(appCheckToken);
      req.log.info("AppCheck verification successful");
      next();
      return;
    } catch (error) {
      req.log.error({ error }, "AppCheck verification failed");
      res.status(401).json({ error: "Invalid AppCheck token" });
      return;
    }
  }

  // Try JWT (NSE or Gateway)
  if (authToken) {
    try {
      const payload = await verifyV2JwtToken({ token: authToken });
      // Store payload for handlers if needed
      res.locals.deviceId = payload.deviceId;
      res.locals.jwtMetadata = payload.metadata;
      req.log.info(
        {
          deviceId: payload.deviceId,
          isNSEOnly: payload.metadata?.notificationExtensionOnly,
        },
        "V2 JWT verification successful",
      );
      next();
      return;
    } catch (error) {
      req.log.error({ error }, "V2 JWT verification failed");
      res.status(401).json({ error: "Invalid auth token" });
      return;
    }
  }

  req.log.warn("No authentication headers provided");
  res.status(401).json({ error: "Missing authentication" });
};
