import type { Request, Response } from "express";
import { z } from "zod";
import { createComposioService } from "@/api/v2/connections/composio.service";
import { prisma } from "@/utils/prisma";
import { resolveTrustedCaller } from "../trusted-identity";

// The agent contract: only what the toolkit needs. No connection id, no account
// id — the backend resolves those from the trusted caller + the grant store, so
// a compromised agent has no field with which to name another account.
const bodySchema = z.object({
  toolkit: z.string().min(1).max(128),
  action: z.string().min(1).max(128),
  args: z.record(z.unknown()).default({}),
});

export async function execHandler(req: Request, res: Response) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const { toolkit, action, args } = parsed.data;

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

  // Action scope: empty actions ⇒ whole toolkit; otherwise the action must be
  // listed (no verb escalation).
  const applicable = grants.filter(
    (g) => g.actions.length === 0 || g.actions.includes(action),
  );
  if (applicable.length === 0) {
    req.log.warn(
      { agentInboxId: caller.agentInboxId, toolkit, action },
      "[Composio] exec: no matching grant",
    );
    res.status(403).json({ code: "no_grant" });
    return;
  }

  // Tier 1 bounds resolution to grants in this conversation. If several owners
  // shared the same toolkit here, we can't disambiguate without the verified
  // sender (Tier 2) — fail closed rather than guess whose data to touch.
  const owners = new Set(applicable.map((g) => g.ownerAccountId));
  if (owners.size > 1) {
    req.log.warn(
      { conversationId: caller.conversationId, toolkit, owners: owners.size },
      "[Composio] exec: ambiguous grant (Tier 2 needed)",
    );
    res.status(409).json({ code: "ambiguous_grant" });
    return;
  }

  const grant = applicable[0];

  try {
    // connectionId (bearer capability) is resolved server-side and never
    // returned to the agent.
    const connectedAccountId =
      grant.connectionId ??
      (await service.resolveConnectionId({
        userId: grant.ownerAccountId,
        toolkit,
      }));
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
