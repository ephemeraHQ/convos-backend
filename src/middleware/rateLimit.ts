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

// Rate limiting for agent join endpoint (10 requests per 5 minutes per IP)
export const agentJoinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 10,
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: { error: "Too many agent join requests, please try again later" },
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

// Pre-auth rate limiting for agent asset uploads (protects API key auth surface)
export const agentAssetPreAuthLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 20,
  keyGenerator: (req) => req.ip || "unknown",
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: { error: "Too many agent auth attempts, please try again later" },
});

// Post-auth rate limiting for agent asset uploads (shared global throughput cap)
export const agentAssetLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 50,
  keyGenerator: () => "agent-global",
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: { error: "Too many agent upload requests, please try again later" },
});
