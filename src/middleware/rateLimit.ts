import { rateLimit } from "express-rate-limit";

// General rate limit for API to 300 requests per 5 minutes
export const rateLimitMiddleware = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 300,
  legacyHeaders: false,
  standardHeaders: "draft-8",
});

// Stricter rate limiting for auth endpoints (JWT generation)
export const authRateLimitMiddleware = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // 10 requests per 15 minutes per IP
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: "Too many authentication requests, please try again later",
});
