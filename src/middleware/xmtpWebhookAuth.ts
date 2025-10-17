import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { getHttpDeliveryNotificationAuthHeader } from "@/notifications/utils";

/**
 * Middleware to verify XMTP webhook authorization header
 * Validates that the request comes from the authorized XMTP notification server
 */
export const xmtpWebhookAuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Fail closed: reject if webhook secret is not configured
  const expectedAuthHeaderRaw = getHttpDeliveryNotificationAuthHeader();
  if (!expectedAuthHeaderRaw || expectedAuthHeaderRaw.trim().length === 0) {
    req.log.error("XMTP webhook secret not configured - rejecting request");
    res.status(500).json({
      error: "Server configuration error",
    });
    return;
  }
  const expectedAuthHeader = expectedAuthHeaderRaw.trim();

  const authHeader = req.headers.authorization?.trim() ?? "";

  // Reject if no authorization header provided
  if (authHeader.length === 0) {
    req.log.error("Missing XMTP webhook authorization header");
    res.status(401).json({
      error: "Unauthorized: Invalid authentication token",
    });
    return;
  }

  const provided = Buffer.from(authHeader, "utf8");
  const expected = Buffer.from(expectedAuthHeader, "utf8");
  const valid =
    provided.length === expected.length && timingSafeEqual(provided, expected);

  if (!valid) {
    req.log.error("Invalid XMTP webhook authorization header");
    res.status(401).json({
      error: "Unauthorized: Invalid authentication token",
    });
    return;
  }

  next();
};
