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
  const authHeader = req.headers.authorization?.trim() ?? "";
  const expectedAuthHeader = getHttpDeliveryNotificationAuthHeader().trim();

  const provided = Buffer.from(authHeader, "utf8");
  const expected = Buffer.from(expectedAuthHeader, "utf8");
  const valid =
    provided.length === expected.length && timingSafeEqual(provided, expected);

  if (!valid) {
    req.log.error("Invalid or missing XMTP webhook authorization header");
    res.status(401).json({
      error: "Unauthorized: Invalid authentication token",
    });
    return;
  }

  next();
};
