import type { Request, Response } from "express";
import { z } from "zod";
import {
  getServiceConfig,
  isKnownAction,
  resolveBundleActions,
} from "@/api/v2/connections/bundles.config";
import { createComposioService } from "@/api/v2/connections/composio.service";
import { prisma } from "@/utils/prisma";
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

  // Authorize on the grant, keyed by the TRUSTED identity (never body fields):
  // the agent (granteeInboxId) must hold a live grant for this conversation,
  // toolkit, and action.
  const now = new Date();
  const grants = await prisma.connectionGrant.findMany({
    where: {
      granteeInboxId: caller.agentInboxId,
      conversationId: caller.conversationId,
      toolkit,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });

  // Action scope: the allowed set is the UNION of the grant's legacy `actions`
  // and the actions its `bundleIds` resolve to against the CURRENT catalog (so
  // re-mapping a bundle needs no client update — the point of bundles). The
  // whole-toolkit transition default applies ONLY to true legacy grants that
  // carry NEITHER actions NOR bundleIds; once clients always send bundleIds it
  // tightens to fail-closed. A grant that DOES carry actions or bundleIds is
  // scoped to exactly what they resolve to — if the union does not contain the
  // requested action (including a union left EMPTY because the bundle ids are
  // unknown/stale to the catalog), the grant is not applicable: fail closed
  // (no_grant), never fall back to whole-toolkit. Owner scope: if the agent
  // named a member (onBehalfOf), keep only that owner's grant — this is how a
  // group query targets one person ("Alice's calendar") without touching
  // anyone else's.
  const applicable = grants.filter((g) => {
    if (onBehalfOf !== undefined && g.ownerInboxId !== onBehalfOf) return false;
    if (g.actions.length === 0 && g.bundleIds.length === 0) {
      req.log.warn(
        { grantId: g.id, toolkit, action },
        "[Composio] exec: grant has no actions/bundleIds — whole-toolkit (transition default)",
      );
      return true;
    }
    const resolved = resolveBundleActions(g.toolkit, g.bundleIds);
    if (g.bundleIds.length > 0 && resolved.length === 0) {
      req.log.warn(
        { grantId: g.id, toolkit, bundleIds: g.bundleIds },
        "[Composio] exec: grant bundleIds resolve to no actions (unknown/stale) — fail closed",
      );
    }
    const allowed = new Set<string>([...g.actions, ...resolved]);
    return allowed.has(action);
  });
  if (applicable.length === 0) {
    // Backstop (authoritative): distinguish a bad slug from a real consent
    // gap. A `no_grant` tells the agent "ask the user to (re-)approve" — but if
    // the agent simply named an action the toolkit never had (observed live:
    // "listEvents", the retired "GOOGLECALENDAR_LIST_EVENTS", "--list-tools"),
    // that is NOT a consent problem, and re-prompting the user for a connection
    // they already granted is the calendar re-auth loop. So when the toolkit is
    // known but the requested action is not in its catalog vocabulary at all,
    // return `invalid_action` instead of `no_grant`. This holds even if the
    // runtime slug guard is bypassed, incomplete, or its allow-list fetch
    // failed — the matcher is the backstop. Unknown toolkits keep falling
    // through to `no_grant` (legacy whole-toolkit grants are keyed by toolkit,
    // not catalog membership, so we must not reclassify those).
    const svc = getServiceConfig(toolkit);
    if (svc && !(await isKnownAction(service, toolkit, action))) {
      req.log.warn(
        { agentInboxId: caller.agentInboxId, toolkit, action },
        "[Composio] exec: action not in toolkit catalog — invalid_action (not a consent gap)",
      );
      res.status(422).json({ code: "invalid_action", toolkit, action });
      return;
    }
    req.log.warn(
      { agentInboxId: caller.agentInboxId, toolkit, action, onBehalfOf },
      "[Composio] exec: no matching grant",
    );
    res.status(403).json({ code: "no_grant" });
    return;
  }

  // Multiple owners shared the same toolkit in this conversation and the agent
  // didn't say whose to use. Fail closed and tell it to pass `onBehalfOf` rather
  // than guess whose data to touch.
  const owners = new Set(applicable.map((g) => g.ownerAccountId));
  if (owners.size > 1) {
    req.log.warn(
      { conversationId: caller.conversationId, toolkit, owners: owners.size },
      "[Composio] exec: ambiguous grant — onBehalfOf required",
    );
    res.status(409).json({ code: "ambiguous_grant" });
    return;
  }

  const grant = applicable[0];

  try {
    // The connection (bearer capability) is resolved SERVER-SIDE from the
    // owner's own account — never from a client-supplied id — and never returned
    // to the agent. This is what makes a stolen connection id unusable: there is
    // no path that acts on a caller-named connection.
    const connectedAccountId = await service.resolveConnectionId({
      userId: grant.ownerAccountId,
      toolkit,
    });
    if (!connectedAccountId) {
      req.log.warn(
        { ownerAccountId: grant.ownerAccountId, toolkit },
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

    const result = await service.execute({
      action,
      userId: grant.ownerAccountId,
      arguments: args,
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
