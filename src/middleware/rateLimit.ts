import type { Request } from "express";
import { rateLimit } from "express-rate-limit";

// General rate limit for API to 1000 requests per 5 minutes
export const rateLimitMiddleware = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 1000,
  legacyHeaders: false,
  standardHeaders: "draft-8",
});

// Stack 2 T12: debug-status endpoint is JWT-authenticated and meant for the
// iOS debug screen's "Probe backend registration" button. Cap at 1
// request/second per JWT (keyed by accountId+deviceId from JWT) so a
// malicious or buggy client can't enumerate by hammering the endpoint.
// Falls back to IP when accountId/deviceId aren't set (which would
// already 401 out before reaching this, but defense in depth).
export const debugStatusLimiter = rateLimit({
  windowMs: 1_000,
  limit: 1,
  legacyHeaders: false,
  standardHeaders: "draft-8",
  keyGenerator: (req: Request) => {
    const deviceId = req.res?.locals.deviceId;
    const accountId = req.res?.locals.accountId;
    if (deviceId && accountId) {
      return `${accountId}|${deviceId}`;
    }
    return req.ip ?? "unknown";
  },
  message: {
    error: "Too many debug-status requests, please slow down",
  },
});

// Stricter rate limiting for auth endpoints (JWT generation)
export const authRateLimitMiddleware = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 100, // 100 requests per 5 minutes per IP
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: "Too many authentication requests, please try again later",
});

// Rate limiting for the agent-provisioning endpoint (POST /api/v2/agents/join).
// Each request kicks off a container-boot workflow upstream — expensive,
// hence the tight 10/5min cap.
export const agentJoinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 10,
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: { error: "Too many agent join requests, please try again later" },
});

// Rate limiting for the agent-status polling endpoint (GET /api/v2/agents/join/:instanceId).
// Cheap upstream call (status read, no workflow side-effects); clients polling
// every ~5s during the fallback async path need headroom above the tight
// provisioning limit, so this is significantly more generous.
export const agentJoinStatusLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 60, // ~1 poll every 5s for 5 minutes
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: { error: "Too many status polls, please try again later" },
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

// Rate limiting for invite code redemption (5 attempts per 15 minutes per IP)
export const inviteCodeRedeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5,
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: {
    success: false,
    error: "RATE_LIMITED",
    message: "Too many code redemption attempts, please try again later",
  },
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
