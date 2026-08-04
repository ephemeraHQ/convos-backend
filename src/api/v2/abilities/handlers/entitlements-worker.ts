import type { Request, Response } from "express";
import { enumerateConversationEntitlements } from "@/api/v2/abilities/check-entitlement";
import { resolveTrustedCaller } from "@/api/v2/composio/trusted-identity";

// GET /v2/abilities/entitlements — the worker-facing enumerate: which
// abilities the calling agent may use in the calling conversation, per owner,
// with the resolved allowed-action union. The runtime worker calls this the
// same way it calls exec, to learn its ability vocabulary without reading
// conversation metadata (docs/plans/abilities-entitlements.md, rollout step 4).
//
// Auth mirrors exec exactly: composioExecAuth at the mount plus the
// worker-stamped trusted identity headers (see trusted-identity.ts). The key
// name (X-Composio-Exec-Key) is legacy-scoped to its first consumer; the route
// itself is vendor-neutral. The caller is the trusted assistants worker — the
// same trust class and key as exec — which is why raw Composio action slugs
// ARE served on this wire, deliberately unlike every client-facing surface
// (which never serves slugs): the worker already sends slugs on the exec path,
// so this response reveals nothing a successful exec would not. Bearer
// capabilities never appear: no connection ids, no account ids.
//
// Readiness: derived from live ConversationAbility rows and their parent
// entitlements only. While those tables are still converging after boot the
// answer is a retryable 503 {code: entitlements_unavailable} — never a
// partial list (see enumerateConversationEntitlements for why exec's legacy
// fallback does not apply here).
export async function entitlementsWorkerHandler(req: Request, res: Response) {
  const caller = resolveTrustedCaller(req);
  if (!caller) {
    req.log.warn("[Abilities] worker enumerate: no trusted identity");
    res.status(403).json({ code: "trusted_identity_unavailable" });
    return;
  }

  const result = await enumerateConversationEntitlements({
    caller,
    log: req.log,
  });
  if (!result.ready) {
    res.status(503).json({ code: "entitlements_unavailable" });
    return;
  }

  // Per-conversation consent state can flip on any user action — never cache.
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ abilities: result.abilities });
}
