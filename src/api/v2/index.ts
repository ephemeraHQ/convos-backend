import { Router } from "express";
import {
  agentApiKeyAuth,
  authOrAgentApiKeyAuth,
  composioExecAuth,
} from "@/middleware/agentAuth";
import {
  appCheckOnlyMiddleware,
  authMiddleware,
  authMiddlewareAllowNSE,
  requireAccount,
} from "@/middleware/auth";
import { devAuthMiddleware } from "@/middleware/devAuth";
import { lifecycleTestAuthMiddleware } from "@/middleware/lifecycleTestAuth";
import {
  agentAssetLimiter,
  agentAssetPreAuthLimiter,
  assetRenewalLimiter,
  inviteCodeRedeemLimiter,
  telemetryLimiter,
} from "@/middleware/rateLimit";
import { abilitiesRouter } from "./abilities/abilities.router";
import { accountsByIdRouter } from "./accounts/accountsByIdRouter";
import { accountsMeRouter } from "./accounts/accountsMeRouter";
import { meGuard } from "./accounts/middleware/meGuard";
import { agentPromptHintsRouter } from "./agent-prompt-hints/agent-prompt-hints.router";
import { agentTemplatesRouter } from "./agent-templates/agent-templates.router";
import { agentVariantsRouter } from "./agent-variants/agent-variants.router";
import { agentsRouter } from "./agents/agents.router";
import { agentAssetsRouter } from "./agents/assets/agent-assets.router";
import { assetsRouter } from "./assets/assets.router";
import { lifecycleStatusHandler } from "./assets/handlers/lifecycle-status";
import { migrateTimestampsHandler } from "./assets/handlers/migrate-timestamps";
import { renewBatchHandler } from "./assets/handlers/renew-batch";
import { testLifecycleHandler } from "./assets/handlers/test-lifecycle";
import { attachmentsRouter } from "./attachments/attachments.router";
import { authRouter } from "./auth/auth.router";
import { composioRouter } from "./composio/composio.router";
import { connectionsRouter } from "./connections/connections.router";
import { actionsGetHandler } from "./connections/handlers/actions-get";
import { servicesGetHandler } from "./connections/handlers/services-get";
import { conversationsRouter } from "./conversations/conversations.router";
import { creditsAdminRouter } from "./credits-admin/credits-admin.router";
import { dailyRefillRouter } from "./credits/daily.router";
import { devRouter } from "./dev/dev.router";
import { deviceRouter } from "./device/device.router";
import {
  inviteCodesAdminRouter,
  inviteCodesRouter,
} from "./invite-codes/invite-codes.router";
import invitesV2Router from "./invites/invites.router";
import { notificationsRouter } from "./notifications/notifications.router";
import { webhookRouter } from "./notifications/webhook.router";
import { appleWebhookRouter } from "./subscriptions/apple-webhook.router";
import { googlePlayWebhookRouter } from "./subscriptions/google-play-webhook.router";
import { telemetryRouter } from "./telemetry/telemetry.router";

const v2Router = Router();

// /dev is a non-production test surface; keep it gated.
if (process.env.XMTP_ENV !== "production") {
  v2Router.use("/dev", devAuthMiddleware, devRouter);
}

v2Router.use("/agent-prompt-hints", agentPromptHintsRouter);

v2Router.use("/agent-templates", agentTemplatesRouter);

// Per-PR agent variants. Per-route auth: GET is app-facing (authMiddleware,
// dev-gated to []), POST/DELETE require the agent API key + dev-gate.
v2Router.use("/agent-variants", agentVariantsRouter);

v2Router.use("/invites", invitesV2Router);

v2Router.use("/credits-admin", creditsAdminRouter);
// Invite codes: admin page + API (auth applied per-route inside the router)
v2Router.use("/invite-codes/admin", inviteCodesAdminRouter);
// Invite codes: client redemption (JWT-authenticated)
v2Router.use(
  "/invite-codes",
  inviteCodeRedeemLimiter,
  authMiddleware,
  inviteCodesRouter,
);
v2Router.use("/auth", authRouter);
// User-facing /accounts/me/* (credits, subscription, subscription/verify) —
// JWT-authed. Agents read/write credits via /accounts/:accountId/credits/*
// with X-Agent-API-Key; the two surfaces are deliberately separate by
// audience, not by resource.
v2Router.use("/accounts/me", authMiddleware, accountsMeRouter);
v2Router.use(
  "/accounts/:accountId",
  agentApiKeyAuth,
  meGuard,
  accountsByIdRouter,
);
v2Router.use("/credits", dailyRefillRouter);
v2Router.use("/device", appCheckOnlyMiddleware, deviceRouter);
v2Router.use(
  "/telemetry",
  telemetryLimiter,
  appCheckOnlyMiddleware,
  telemetryRouter,
);

// Lifecycle test endpoints - protected by token auth, must be before authenticated /assets route
v2Router.post(
  "/assets/test/lifecycle",
  lifecycleTestAuthMiddleware,
  assetRenewalLimiter,
  testLifecycleHandler,
);
v2Router.post(
  "/assets/test/lifecycle-status",
  lifecycleTestAuthMiddleware,
  assetRenewalLimiter,
  lifecycleStatusHandler,
);
// One-time migration endpoint - remove after lifecycle rule is enabled
v2Router.post(
  "/assets/test/migrate-timestamps",
  lifecycleTestAuthMiddleware,
  migrateTimestampsHandler,
);

// Renew assets with either JWT auth (iOS clients) or agent API key auth
v2Router.post(
  "/assets/renew-batch",
  authOrAgentApiKeyAuth,
  assetRenewalLimiter,
  renewBatchHandler,
);

v2Router.use("/assets", authMiddleware, assetsRouter);

v2Router.use(
  "/agents/assets",
  agentAssetPreAuthLimiter,
  agentApiKeyAuth,
  agentAssetLimiter,
  agentAssetsRouter,
);
// Per-route rate limiters live in agents.router.ts so the polling endpoint
// (cheap) and the provisioning endpoint (expensive) get separately tuned
// limits. authMiddleware applies to the whole subtree.
v2Router.use("/agents", authMiddleware, agentsRouter);
// Agent participation is keyed by conversation, not by agent: one level governs
// every agent in the room, so it hangs off the conversation, not /agents.
v2Router.use("/conversations", authMiddleware, conversationsRouter);
v2Router.use("/attachments", authMiddleware, attachmentsRouter);
// The Connections V2 ability catalog (docs/plans/abilities-entitlements.md).
// JWT-only, deliberately without requireAccount: device-only tokens can browse
// the catalog; entitlement state appears only when the JWT carries an account.
v2Router.use("/abilities", authMiddleware, abilitiesRouter);
// The connections-picker catalog is JWT-only (NOT account-scoped): the catalog
// is identical for every user, so requireAccount is deliberately not applied.
// Declared BEFORE the requireAccount-gated /connections mount so this more
// specific path is matched first and never forced through requireAccount.
v2Router.get("/connections/services", authMiddleware, servicesGetHandler);
// Action-slug vocabulary for one toolkit so the agent runtime can validate a
// requested action slug before exec. Auth MIRRORS /v2/composio/exec
// (composioExecAuth / X-Composio-Exec-Key): the agent reaches the backend
// through the trusted worker using the exec credential, not a per-user JWT, so a
// JWT gate here would 401 the very caller that needs it. The exec key lives only
// in the worker (never the container), giving this read parity with — not
// weaker than — exec. Declared before the requireAccount-gated /connections
// mount so this more specific path is matched first.
v2Router.get(
  "/connections/services/:toolkit/actions",
  composioExecAuth,
  actionsGetHandler,
);
v2Router.use("/connections", authMiddleware, requireAccount, connectionsRouter);
// Agent-facing tool execution. A DEDICATED exec key (held only by the trusted
// worker, never in the container, and not injected by the generic convos.internal
// proxy) authenticates the caller; the exec handler then authorizes per-account
// against the worker-stamped identity headers + the grant store.
v2Router.use("/composio", composioExecAuth, composioRouter);
v2Router.use("/notifications/xmtp", webhookRouter);
v2Router.use("/notifications", authMiddleware, notificationsRouter);
// No auth: Apple authenticates via JWS signature, verified inside the handler.
v2Router.use("/webhooks/apple", appleWebhookRouter);
// No auth: Google authenticates via OIDC bearer, verified inside the handler.
v2Router.use("/webhooks/google-play", googlePlayWebhookRouter);

// Auth check endpoint - allows NSE tokens for diagnostics
v2Router.get("/auth-check", authMiddlewareAllowNSE, (_req, res) => {
  res.status(200).json({
    success: true,
  });
  return;
});

// Account-bound auth check - returns 200 only if JWT carries accountId claim.
// Method-agnostic: works for any AuthMethodType today (SIWE) or future
// (Google, Apple, passkey, ...). Used by clients to probe whether they need to
// trigger an account-upgrade flow (e.g. SIWE login) before hitting routes
// gated by requireAccount.
v2Router.get(
  "/account-auth-check",
  authMiddleware,
  requireAccount,
  (_req, res) => {
    res.status(200).json({
      success: true,
    });
    return;
  },
);

export default v2Router;
