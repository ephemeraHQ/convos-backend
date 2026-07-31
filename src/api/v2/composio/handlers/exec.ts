import type { Request, Response } from "express";
import { z } from "zod";
import { checkEntitlement } from "@/api/v2/abilities/check-entitlement";
import { createComposioService } from "@/api/v2/connections/composio.service";
import { resolveTrustedCaller } from "../trusted-identity";

// The agent contract: only what the toolkit needs, plus an optional owner
// selector. No connection id, no account id — the backend resolves those from
// the trusted caller + the grant store. `onBehalfOf` is the inbox id of the
// member whose connection to act on (e.g. "query Alice's calendar" in a group);
// it is only a SELECTOR among the agent's authorized grants — naming a member
// who never granted this agent simply yields no_grant, so it cannot widen access.
const bodySchema = z.object({
  toolkit: z.string().min(1).max(128),
  action: z.string().min(1).max(128),
  args: z.record(z.unknown()).default({}),
  onBehalfOf: z.string().min(1).max(256).optional(),
});

export async function execHandler(req: Request, res: Response) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const { toolkit, action, args, onBehalfOf } = parsed.data;

  // Fail closed: without a forgery-proof (conversationId, agentInboxId), exec
  // cannot safely decide whose connection to use. See trusted-identity.ts.
  const caller = resolveTrustedCaller(req);
  if (!caller) {
    req.log.warn({ toolkit, action }, "[Composio] exec: no trusted identity");
    res.status(403).json({ code: "trusted_identity_unavailable" });
    return;
  }

  const service = createComposioService();
  if (!service) {
    res.status(503).json({ error: "Connections not configured" });
    return;
  }

  // Authorize via checkEntitlement, keyed by the TRUSTED identity (never body
  // fields): the agent must hold a live conversation ability (the reshaped
  // grant) for this conversation, ability, and action. The check preserves V1
  // exec semantics verbatim — the action-scope union (legacy actions +
  // bundle-resolved against the CURRENT catalog; whole-toolkit only when both
  // are empty; unresolvable bundles fail closed), the onBehalfOf owner
  // selector, invalid_action-before-no_grant on a slug the toolkit never had
  // (fail-open on catalog outage), and ambiguous_grant when several owners
  // extended the same ability here. See check-entitlement.ts for the full
  // decision tree and rationale.
  const check = await checkEntitlement({
    caller: {
      kind: "conversation",
      conversationId: caller.conversationId,
      agentInboxId: caller.agentInboxId,
    },
    abilityId: toolkit,
    action,
    onBehalfOf,
    catalog: service,
    log: req.log,
  });

  if (!check.allowed) {
    switch (check.code) {
      case "invalid_action":
        res.status(422).json({ code: "invalid_action", toolkit, action });
        return;
      case "ambiguous_grant":
        res.status(409).json({ code: "ambiguous_grant" });
        return;
      case "no_grant":
        res.status(403).json({ code: "no_grant" });
        return;
      default:
        // Lifecycle codes (needs_reauth, unknown_ability) are account-path
        // only and unreachable here; keep the exec wire frozen by failing
        // closed as the consent denial.
        req.log.warn(
          { toolkit, action, code: check.code },
          "[Composio] exec: unexpected check denial — mapping to no_grant",
        );
        res.status(403).json({ code: "no_grant" });
        return;
    }
  }

  try {
    // The connection (bearer capability) is resolved SERVER-SIDE from the
    // owner's own account — never from a client-supplied id — and never returned
    // to the agent. This is what makes a stolen connection id unusable: there is
    // no path that acts on a caller-named connection.
    const connectedAccountId = await service.resolveConnectionId({
      userId: check.ownerAccountId,
      toolkit,
    });
    if (!connectedAccountId) {
      req.log.warn(
        { ownerAccountId: check.ownerAccountId, toolkit },
        "[Composio] exec: no connection for owner+toolkit",
      );
      res.status(409).json({ code: "connection_not_found" });
      return;
    }

    // Composio refuses manual execution against the implicit "latest" toolkit
    // version (TOOL_VERSION_REQUIRED). Pin the toolkit's current published
    // version, resolved from Composio and cached in-process; if it cannot be
    // determined, fail closed rather than skip the version check.
    const version = await service.resolveToolkitVersion(toolkit);
    if (!version) {
      req.log.error(
        { toolkit, action },
        "[Composio] exec: toolkit version unresolved",
      );
      res.status(502).json({ code: "toolkit_version_unresolved" });
      return;
    }

    // Gmail actions address a target mailbox through a user_id argument
    // ("me" or a delegated address the OAuth principal can reach). Consent
    // covers the connected member's own mailbox only, so a caller-supplied
    // user_id is never honored: it is overwritten with "me" before the
    // Composio call. Enforced here because raw exec is the one path every
    // agent-supplied argument must pass through.
    const pinnedArgs: Record<string, unknown> =
      toolkit.toLowerCase() === "gmail" ? { ...args, user_id: "me" } : args;

    const result = await service.execute({
      action,
      userId: check.ownerAccountId,
      arguments: pinnedArgs,
      connectedAccountId,
      version,
    });

    res.status(200).json({ data: result.data });
    return;
  } catch (error) {
    req.log.error({ error, toolkit, action }, "[Composio] exec failed");
    res.status(502).json({ error: "Tool execution failed" });
    return;
  }
}
