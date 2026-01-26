import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Validates that the request has a valid LIFECYCLE_TEST_TOKEN.
 * Used to protect lifecycle test endpoints from unauthorized access.
 */
export const lifecycleTestAuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Fail closed: reject if token is not configured
  const expectedToken = process.env.LIFECYCLE_TEST_TOKEN?.trim();
  if (!expectedToken || expectedToken.length === 0) {
    req.log.error("LIFECYCLE_TEST_TOKEN not configured - rejecting request");
    res.status(500).json({
      error: "Server configuration error",
    });
    return;
  }

  const authHeader = req.headers.authorization?.trim() ?? "";

  // Reject if no authorization header provided
  if (authHeader.length === 0) {
    req.log.error("Missing lifecycle test authorization header");
    res.status(401).json({
      error: "Unauthorized: Missing authentication token",
    });
    return;
  }

  // Extract token from "Bearer <token>" format
  const providedToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : authHeader.trim();

  if (providedToken.length === 0) {
    req.log.error("Empty lifecycle test token");
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
    req.log.error("Invalid lifecycle test authorization token");
    res.status(401).json({
      error: "Unauthorized: Invalid authentication token",
    });
    return;
  }

  next();
};
