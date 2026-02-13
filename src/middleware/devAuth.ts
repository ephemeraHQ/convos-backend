import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Validates that the request has a valid DEV_API_TOKEN.
 * Used to protect dev-only endpoints from unauthorized access.
 */
export const devAuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const expectedToken = process.env.DEV_API_TOKEN?.trim();
  if (!expectedToken || expectedToken.length < 32) {
    req.log.error(
      "DEV_API_TOKEN not configured or too short (min 32 chars) - rejecting request",
    );
    res.status(500).json({
      error: "Server configuration error",
    });
    return;
  }

  const authHeader = req.headers.authorization?.trim() ?? "";

  if (authHeader.length === 0) {
    req.log.error("Missing dev auth authorization header");
    res.status(401).json({
      error: "Unauthorized: Missing authentication token",
    });
    return;
  }

  const providedToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : authHeader.trim();

  if (providedToken.length === 0) {
    req.log.error("Empty dev auth token");
    res.status(401).json({
      error: "Unauthorized: Invalid authentication token",
    });
    return;
  }

  const provided = Buffer.from(providedToken, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  const valid =
    provided.length === expected.length && timingSafeEqual(provided, expected);

  if (!valid) {
    req.log.error("Invalid dev auth authorization token");
    res.status(401).json({
      error: "Unauthorized: Invalid authentication token",
    });
    return;
  }

  next();
};
