import type { Request, Response } from "express";
import { z } from "zod";
import { normalizeAbilityId } from "@/api/v2/abilities/ability-id";
import { getPublicAbilities } from "@/api/v2/abilities/manifests.config";
import { getServiceConfig } from "@/api/v2/connections/bundles.config";
import { upsertConversationAbilityExtension } from "@/api/v2/connections/v1-grant-adapter";
import { prisma } from "@/utils/prisma";

// PUT /v2/conversations/{conversationId}/abilities/{abilityId} — extend (or
// update) the caller's entitlement to one agent in one conversation
// (docs/plans/abilities-entitlements.md, "Extend"). requireAccount.
//
// Requires an ACTIVE entitlement; 409 needs_entitlement otherwise — the
// client deep-links to the ability list to (re)connect first. The opt-in is
// per (ability, agent): a second agent in the conversation never inherits,
// it needs its own PUT.
//
// bundleIds must be non-empty: an empty scope would collide with the legacy
// whole-toolkit transition default in the check (empty actions + empty
// bundleIds = everything), which a V2 write must never produce. Withdrawing
// is DELETE, not an empty PUT.
//
// Response contract: docs/schemas/conversation-abilities.schema.json ($defs
// entry shape).

const bodySchema = z.object({
  agentInboxId: z.string().min(1).max(256),
  bundleIds: z.array(z.string().min(1).max(128)).min(1).max(128),
  // Who is extending, as the caller's inbox id in this conversation. Optional
  // (server cannot derive it); when present it powers the check's onBehalfOf
  // owner selector and the "extended by" display.
  extendedByInboxId: z.string().min(1).max(256).optional(),
});

export { bodySchema as conversationAbilityPutBodySchema };

const paramsSchema = z.object({
  conversationId: z.string().min(1).max(256),
  abilityId: z.string().min(1).max(128),
});

export async function conversationAbilityPutHandler(
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
  const { agentInboxId, bundleIds, extendedByInboxId } = parsed.data;

  // Same write-time guard as V1 grants: unknown bundle ids get an actionable
  // 400 instead of an opt-in that silently authorizes nothing (the check
  // fails closed on unresolvable ids as defense in depth).
  const svc = getServiceConfig(abilityId);
  const known = new Set(svc?.bundles.map((b) => b.id) ?? []);
  const unknown = bundleIds.find((id) => !known.has(id));
  if (unknown !== undefined) {
    res.status(400).json({ code: "unknown_bundle", bundleId: unknown });
    return;
  }

  const entitlement = await prisma.abilityEntitlement.findUnique({
    where: { accountId_abilityId: { accountId, abilityId } },
  });
  if (
    !entitlement ||
    entitlement.revokedAt ||
    entitlement.status !== "active"
  ) {
    res.status(409).json({ code: "needs_entitlement" });
    return;
  }

  // The shared cross-store write service (see v1-grant-adapter.ts): upserts
  // the opt-in and mirrors a legacy ConnectionGrant row in one transaction,
  // so old exec replicas and V1 read/delete surfaces stay coherent with
  // V2-written state during the compatibility window.
  const extension = await upsertConversationAbilityExtension({
    accountId,
    entitlementId: entitlement.id,
    abilityId,
    conversationId,
    agentInboxId,
    bundleIds,
    extendedByInboxId,
  });

  req.log.info(
    { accountId, abilityId, conversationId, agentInboxId },
    "[Abilities] extension upserted",
  );
  res.status(200).json({
    abilityId,
    conversationId,
    agentInboxId,
    bundleIds: extension.bundleIds,
    extendedByInboxId: extension.extendedByInboxId,
    extendedByMe: true,
    status: entitlement.status,
    createdAt: extension.createdAt,
    updatedAt: extension.updatedAt,
  });
}
