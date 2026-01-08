import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { getHttpDeliveryNotificationAuthHeader } from "@/notifications/utils";

/**
 * Validates that the request comes from the authorized XMTP notification server
 */
export const webhookAuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Fail closed: reject if webhook secret is not configured
  let expectedAuthHeader: string;
  try {
    const expectedAuthHeaderRaw = getHttpDeliveryNotificationAuthHeader();
    if (!expectedAuthHeaderRaw || expectedAuthHeaderRaw.trim().length === 0) {
      throw new Error("Webhook secret is empty");
    }
    expectedAuthHeader = expectedAuthHeaderRaw.trim();
  } catch (error) {
    req.log.error(
      { error },
      "XMTP webhook secret not configured - rejecting request",
    );
    res.status(500).json({
      error: "Server configuration error",
    });
    return;
  }

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
