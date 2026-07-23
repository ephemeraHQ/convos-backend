import type { Request, Response } from "express";
import { z } from "zod";
import { createComposioService } from "@/api/v2/connections/composio.service";
import { prisma } from "@/utils/prisma";

// DELETE /v2/abilities/{abilityId}/entitlement — revoke
// (docs/plans/abilities-entitlements.md, "Bind"). requireAccount.
//
// Order matters: the external teardown runs FIRST, and a Composio failure
// answers 502 with the entitlement untouched — tombstoning a row whose
// credential still exists would lie to the user (and the backfill's
// never-touch-revoked rule means reconciliation could not repair it). On
// success: every Composio connection for the toolkit is deleted (the
// multi-credential rule — duplicates go with the entitlement), conversation
// extensions are deleted, legacy V1 grants are soft-revoked (rolling-deploy
// symmetry), and the row is kept as an audit tombstone (status revoked,
// revokedAt, credential ref cleared).
//
// Idempotent: deleting an already-revoked entitlement re-runs the teardown
// (harmlessly) and answers 204 again; only a never-bound ability is 404.
// The ability id is matched against the caller's rows, not the catalog, so a
// hidden or removed ability can still be revoked.

const paramsSchema = z.object({ abilityId: z.string().min(1).max(128) });

export async function entitlementDeleteHandler(req: Request, res: Response) {
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
  const abilityId = params.data.abilityId.toLowerCase();
  const entitlement = await prisma.abilityEntitlement.findUnique({
    where: { accountId_abilityId: { accountId, abilityId } },
  });
  if (!entitlement) {
    res.status(404).json({ code: "not_found" });
    return;
  }

  // External teardown first (see the module comment). No service configured
  // means no external credential can exist — local teardown only.
  const service = createComposioService();
  if (service) {
    try {
      const { items } = await service.listForUser(accountId);
      const matching = items.filter(
        (item) => item.toolkit.slug.toLowerCase() === abilityId,
      );
      for (const item of matching) {
        await service.delete(item.id);
      }
      if (matching.length > 0) {
        req.log.info(
          { accountId, abilityId, deleted: matching.length },
          "[Abilities] revoke: Composio connections deleted",
        );
      }
    } catch (error) {
      req.log.error(
        { error, accountId, abilityId },
        "[Abilities] revoke: external teardown failed — entitlement untouched",
      );
      res.status(502).json({ code: "revoke_failed" });
      return;
    }
  }

  await prisma.conversationAbility.deleteMany({
    where: { entitlementId: entitlement.id },
  });
  await prisma.connectionGrant.updateMany({
    where: {
      ownerAccountId: accountId,
      toolkit: { equals: abilityId, mode: "insensitive" },
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  await prisma.abilityEntitlement.update({
    where: { id: entitlement.id },
    data: {
      status: "revoked",
      revokedAt: entitlement.revokedAt ?? new Date(),
      externalConnectionId: null,
    },
  });

  req.log.info({ accountId, abilityId }, "[Abilities] entitlement revoked");
  res.status(204).end();
}
