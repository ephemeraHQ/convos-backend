import { rateLimit } from "express-rate-limit";

// General rate limit for API to 1000 requests per 5 minutes
export const rateLimitMiddleware = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 1000,
  legacyHeaders: false,
  standardHeaders: "draft-8",
});

// Stricter rate limiting for auth endpoints (JWT generation)
export const authRateLimitMiddleware = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 100, // 100 requests per 5 minutes per IP
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: "Too many authentication requests, please try again later",
});

// Rate limiting for asset renewal endpoint (10 batch requests per hour per device)
export const assetRenewalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10, // 10 batch requests per hour (up to 1000 assets)
  keyGenerator: (req, res) =>
    (res as { locals?: { deviceId?: string } }).locals?.deviceId ||
    req.ip ||
    "unknown",
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: { error: "Too many renewal requests, please try again later" },
});
