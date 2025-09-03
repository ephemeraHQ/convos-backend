import type { NextFunction, Request, Response } from "express";
import { isEndpointAllowed, verifyJwtToken } from "@/utils/jwt";

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

    // Check if endpoint is allowed (if metadata specifies restrictions)
    const endpoint = req.path;
    if (!isEndpointAllowed({ payload, endpoint })) {
      res.status(403).json({ error: "Access denied for this endpoint" });
      return;
    }

    // Set values for request handlers
    req.app.locals.xmtpId = payload.inboxId;
    req.app.locals.xmtpInstallationId = payload.xmtpInstallationId;

    next();
  } catch (error) {
    // Handle specific error types for better debugging
    if (error instanceof Error && error.message.includes("Access denied")) {
      res.status(403).json({ error: error.message });
      return;
    }
    res.status(401).send();
    return;
  }
};
