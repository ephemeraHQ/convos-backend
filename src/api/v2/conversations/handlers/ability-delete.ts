import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

// DELETE /v2/conversations/{conversationId}/abilities/{abilityId}
// ?agentInboxId=... — withdraw that agent's opt-in
// (docs/plans/abilities-entitlements.md, "Extend"). requireAccount.
//
// Deletes the extension row (no per-extension tombstone; the entitlement is
// the audit record) and soft-revokes the matching legacy V1 grant rows so old
// replicas reading ConnectionGrant during a rolling deploy see the withdrawal
// too. Scoped to the caller's own entitlement — one member cannot withdraw
// another member's opt-in. Matched against the caller's rows, not the
// catalog, so an opt-in for a since-hidden ability can still be withdrawn.

const querySchema = z.object({
  agentInboxId: z.string().min(1).max(256),
});

export { querySchema as conversationAbilityDeleteQuerySchema };

const paramsSchema = z.object({
  conversationId: z.string().min(1).max(256),
  abilityId: z.string().min(1).max(128),
});

export async function conversationAbilityDeleteHandler(
  req: Request,
  res: Response,
) {
  const accountId = res.locals.accountId;
  if (!accountId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const params = paramsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ code: "invalid_request" });
    return;
  }
  const conversationId = params.data.conversationId;
  const abilityId = params.data.abilityId.toLowerCase();
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const { agentInboxId } = parsed.data;

  const entitlement = await prisma.abilityEntitlement.findUnique({
    where: { accountId_abilityId: { accountId, abilityId } },
  });
  if (!entitlement) {
    res.status(404).json({ code: "not_found" });
    return;
  }

  const deleted = await prisma.conversationAbility.deleteMany({
    where: { entitlementId: entitlement.id, conversationId, agentInboxId },
  });
  if (deleted.count === 0) {
    res.status(404).json({ code: "not_found" });
    return;
  }

  await prisma.connectionGrant.updateMany({
    where: {
      ownerAccountId: accountId,
      toolkit: { equals: abilityId, mode: "insensitive" },
      conversationId,
      granteeInboxId: agentInboxId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  req.log.info(
    { accountId, abilityId, conversationId, agentInboxId },
    "[Abilities] extension withdrawn",
  );
  res.status(204).end();
}
