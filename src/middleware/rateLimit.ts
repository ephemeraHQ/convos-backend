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

// Rate limiting for the agent-provisioning endpoint (POST /api/v2/agents/join).
// Each request kicks off a container-boot workflow upstream — expensive, so
// the cap stays tight relative to other endpoints — but clients that
// auto-attach a default agent at conversation creation provision in bursts
// (cache fill plus retries), so the window leaves headroom above steady-state
// one-at-a-time joins.
export const agentJoinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 30,
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

// Rate limiting for the agent participation endpoint
// (PATCH /api/v2/agents/:instanceId/participation). A person tapping through
// levels in a sheet produces a handful of calls, not a stream, so this sits
// well below status polling. Each call is one small upstream write.
export const agentParticipationLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 30,
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: {
    error: "Too many participation changes, please try again later",
  },
});

// Space-to-starter proposals can update a GitHub branch and draft pull request,
// so keep retries bounded independently of the cheaper participation controls.
export const spaceUpstreamLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => req.ip || "unknown",
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: {
    code: "RATE_LIMITED",
    error: "Too many Space PR proposals; retry shortly",
  },
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

// Rate limiting for the build-attachment presigned-URL endpoint
// (GET /api/v2/agent-templates/attachments/presigned). Each request mints an
// S3 PUT capability token, and there's no global ceiling behind this — only the
// per-kind size cap and the object lifecycle bound an abuser — so the per-IP cap
// is the blast-radius limit on unbounded minting. Only the agent-API-key caller
// (the twitter bot, which mints up to 9 presigns per multi-photo mention behind
// one egress IP) is exempted via `skip`; anonymous and signed-in (JWT) callers
// stay capped. The exemption requires the auth middleware to run BEFORE this
// limiter so `res.locals` carries the resolved identity (see the route wiring in
// agent-templates.router.ts).
export const buildAttachmentPresignedLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 20,
  keyGenerator: (req) => req.ip || "unknown",
  // Only the agent-API-key caller bypasses the cap. `res.locals.isApiKeyListener`
  // is set exclusively on that path (→ ADMIN_ACCOUNT_ID); anonymous and JWT
  // callers keep `isApiKeyListener` falsy and stay subject to the per-IP limit.
  skip: (_req, res) => res.locals.isApiKeyListener === true,
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: {
    error: "Too many attachment upload requests, please try again later",
  },
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

// Telemetry batches: clients export every ~15 min plus foreground flushes.
// App Check appId identifies the app, not the device, so key on IP.
export const telemetryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 120,
  keyGenerator: (req) => req.ip || "unknown",
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: { error: "Too many telemetry uploads, please try again later" },
});
