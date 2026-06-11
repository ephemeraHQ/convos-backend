import type { Request, Response } from "express";
import { z } from "zod";
import { resolveBundleActions } from "@/api/v2/connections/bundles.config";
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
  // re-mapping a bundle needs no client update — the point of bundles). If that
  // union is empty (neither actions nor bundleIds — a legacy/transition grant)
  // the grant authorizes the whole toolkit, logged as a warning; once clients
  // always send bundleIds this default tightens to fail-closed. Owner scope: if
  // the agent named a member (onBehalfOf), keep only that owner's grant — this
  // is how a group query targets one person ("Alice's calendar") without
  // touching anyone else's.
  const applicable = grants.filter((g) => {
    if (onBehalfOf !== undefined && g.ownerInboxId !== onBehalfOf) return false;
    const allowed = new Set<string>(g.actions);
    for (const a of resolveBundleActions(g.toolkit, g.bundleIds)) {
      allowed.add(a);
    }
    if (allowed.size === 0) {
      req.log.warn(
        { grantId: g.id, toolkit, action },
        "[Composio] exec: grant has no actions/bundleIds — whole-toolkit (transition default)",
      );
      return true;
    }
    return allowed.has(action);
  });
  if (applicable.length === 0) {
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

    const result = await service.execute({
      action,
      userId: grant.ownerAccountId,
      arguments: args,
      connectedAccountId,
    });

    res.status(200).json({ data: result.data });
    return;
  } catch (error) {
    req.log.error({ error, toolkit, action }, "[Composio] exec failed");
    res.status(502).json({ error: "Tool execution failed" });
    return;
  }
}
