import type { Request, Response } from "express";
import { z } from "zod";
import {
  getPublicAbilities,
  getServedAbilityVersion,
} from "@/api/v2/abilities/manifests.config";
import { createComposioService } from "@/api/v2/connections/composio.service";
import { prisma } from "@/utils/prisma";

// POST /v2/abilities/{abilityId}/entitlement/complete — post-callback
// ownership verification, mirroring V1 /v2/connections/complete: the
// connection must belong to the caller's own account (verified by listing the
// caller's connections, never by trusting the id) and to this ability's
// toolkit. On success the entitlement flips to active and records the
// credential as its backend-only externalConnectionId. requireAccount.
//
// Lenient about a missing row (upsert): the OAuth callback can race a
// restart, and completing a bind the backend lost track of is strictly
// convergent. Completion is an explicit user action, so it clears a
// revocation tombstone.
//
// Response contract: docs/schemas/ability-entitlement-complete.schema.json.

const bodySchema = z.object({
  connectionRequestId: z.string().min(1).max(256),
});

export { bodySchema as entitlementCompleteBodySchema };

const paramsSchema = z.object({ abilityId: z.string().min(1).max(128) });

export async function entitlementCompleteHandler(req: Request, res: Response) {
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
  const ability = getPublicAbilities().find((a) => a.id === abilityId);
  if (!ability) {
    res.status(404).json({ code: "unknown_ability" });
    return;
  }

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", issues: parsed.error.issues });
    return;
  }

  const service = createComposioService();
  if (!service) {
    res.status(503).json({ error: "Connections not configured" });
    return;
  }

  try {
    const owned = await service.getIfOwned({
      connectionId: parsed.data.connectionRequestId,
      userId: accountId,
    });
    if (!owned) {
      res.status(403).json({ code: "connection_not_owned" });
      return;
    }
    if (owned.toolkit.slug.toLowerCase() !== abilityId) {
      // A real connection of the caller's, but for a different toolkit than
      // the ability being completed — reject rather than mis-bind.
      res.status(409).json({ code: "ability_mismatch" });
      return;
    }

    await prisma.abilityEntitlement.upsert({
      where: { accountId_abilityId: { accountId, abilityId } },
      create: {
        accountId,
        abilityId,
        status: "active",
        externalConnectionId: owned.id,
        abilityVersion: getServedAbilityVersion(abilityId),
      },
      update: {
        status: "active",
        externalConnectionId: owned.id,
        revokedAt: null,
      },
    });

    req.log.info(
      { accountId, abilityId },
      "[Abilities] complete: entitlement active",
    );
    res.status(200).json({ status: "active" });
    return;
  } catch (error) {
    req.log.error(
      { error, accountId, abilityId },
      "[Abilities] complete failed",
    );
    res.status(502).json({ code: "complete_failed" });
    return;
  }
}
