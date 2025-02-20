import type { NextFunction, Request, Response } from "express";
import * as jose from "jose";

export const AUTH_HEADER = "X-Convos-AuthToken";

// Extend Express Request type
export interface RequestWithXmtp extends Request {
  xmtpId: string;
}

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
    const { payload } = await jose.jwtVerify(
      authToken,
      new TextEncoder().encode(process.env.JWT_SECRET),
    );

    // Add xmtpId to the request object
    // @ts-ignore
    req.xmtpId = payload.inboxId as string;

    next();
  } catch {
    res.status(401).send();
  }
};
