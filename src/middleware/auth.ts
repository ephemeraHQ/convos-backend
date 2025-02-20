import type { NextFunction, Request, Response } from "express";
import * as jose from "jose";

export const AUTH_HEADER = "X-Convos-AuthToken";

export type JWTPayload = {
  inboxId: string;
};

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

    // add xmtpId to app local variables
    req.app.locals.xmtpId = payload.inboxId;

    next();
  } catch {
    res.status(401).send();
  }
};
