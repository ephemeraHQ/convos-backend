import type { NextFunction, Request, Response } from "express";
import * as jose from "jose";
import type { JWTPayload } from "@/api/v1/authenticate";

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
    // verify JWT token and get payload
    const { payload } = await jose.jwtVerify<JWTPayload>(
      authToken,
      new TextEncoder().encode(process.env.JWT_SECRET),
    );

    // So we can use them in request handlers
    req.app.locals.xmtpId = payload.inboxId;
    req.app.locals.xmtpInstallationId = payload.xmtpInstallationId;

    next();
  } catch {
    res.status(401).send();
  }
};
