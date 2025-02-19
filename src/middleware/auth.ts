import type { NextFunction, Request, Response } from "express";
import * as jose from "jose";

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
    // verify JWT token
    await jose.jwtVerify(
      authToken,
      new TextEncoder().encode(process.env.JWT_SECRET),
    );

    next();
  } catch {
    res.status(401).send();
  }
};
