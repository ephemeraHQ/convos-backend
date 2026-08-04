import type { Request, Response } from "express";
import { z } from "zod";
import { normalizeAbilityId } from "@/api/v2/abilities/ability-id";
import { prisma } from "@/utils/prisma";

// DELETE /v2/conversations/{conversationId}/abilities/{abilityId}
// ?agentInboxId=... — withdraw that agent's opt-in
// (docs/plans/abilities-entitlements.md, "Extend"). requireAccount.
//
// Deletes the extension row (no per-extension tombstone; the entitlement is
// the audit record) and soft-revokes the matching legacy V1 grant rows so old
// replicas reading ConnectionGrant during a rolling deploy see the withdrawal
// too. Both writes run in ONE transaction, and the legacy revoke runs even
// when no extension row was found: a retry after a partial failure (or state
// an old replica diverged) heals the surviving counterpart before answering
// 404. Scoped to the caller's own entitlement — one member cannot withdraw
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
  const abilityId = normalizeAbilityId(params.data.abilityId);
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

  const { deletedCount, legacyRevokedCount } = await prisma.$transaction(
    async (tx) => {
      const deleted = entitlement
        ? await tx.conversationAbility.deleteMany({
            where: {
              entitlementId: entitlement.id,
              conversationId,
              agentInboxId,
            },
          })
        : { count: 0 };
      // Unconditional: heals a live legacy row even when the extension is
      // already gone (retry after partial failure, old-replica divergence).
      const legacyRevoked = await tx.connectionGrant.updateMany({
        where: {
          ownerAccountId: accountId,
          toolkit: { equals: abilityId, mode: "insensitive" },
          conversationId,
          granteeInboxId: agentInboxId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      return {
        deletedCount: deleted.count,
        legacyRevokedCount: legacyRevoked.count,
      };
    },
  );

  // Success when EITHER store transitioned: during the backfill/cutover
  // window a live legacy grant can exist with no entitlement row yet, and
  // the legacy revoke above withdraws real consent — answering 404 for it
  // would report failure for a withdrawal that took effect.
  if (deletedCount === 0 && legacyRevokedCount === 0) {
    res.status(404).json({ code: "not_found" });
    return;
  }

  req.log.info(
    { accountId, abilityId, conversationId, agentInboxId },
    "[Abilities] extension withdrawn",
  );
  res.status(204).end();
}
