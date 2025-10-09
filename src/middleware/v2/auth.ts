import type { NextFunction, Request, Response } from "express";
import { verifyAppCheckToken } from "@/utils/firebase";
import { verifyV2JwtToken } from "@/utils/v2/jwt";

export const AUTH_HEADER = "X-Convos-AuthToken";
export const APPCHECK_HEADER = "X-Firebase-AppCheck";

export const authV2Middleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const appCheckToken = req.header(APPCHECK_HEADER);
  const authToken = req.header(AUTH_HEADER);

  // Try AppCheck first (main app)
  if (appCheckToken) {
    try {
      await verifyAppCheckToken(appCheckToken);
      return next();
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
      res.locals.clientIdentifier = payload.clientIdentifier;
      res.locals.deviceId = payload.deviceId;
      res.locals.jwtMetadata = payload.metadata;
      return next();
    } catch (error) {
      req.log.error({ error }, "V2 JWT verification failed");
      res.status(401).json({ error: "Invalid auth token" });
      return;
    }
  }

  res.status(401).json({ error: "Missing authentication" });
};
