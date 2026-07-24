import type { Request, Response } from "express";
import { z } from "zod";
import { normalizeAbilityId } from "@/api/v2/abilities/ability-id";
import { isEntitlementReadModelReady } from "@/api/v2/abilities/read-readiness";
import { prisma } from "@/utils/prisma";

// GET /v2/conversations/{conversationId}/abilities — the conversation's view:
// one entry per (ability, agent) opt-in, across every member, for the
// conversation info screen (docs/plans/abilities-entitlements.md, "Extend").
// requireAccount.
//
// Access model: possession of the opaque XMTP conversationId is the proof of
// membership, as everywhere else this backend handles conversation-scoped
// state (there is no membership table; V1 exposed the same facts to every
// member via conversation metadata). What each entry serves is bounded
// accordingly: the extender's inbox id (a conversation-visible identity) and
// the backing entitlement's status — never another member's accountId, never
// credential ids, never raw action slugs. `extendedByMe` marks the rows the
// caller owns (the ones it may PUT/DELETE).
//
// Until the migration ledgers confirm the entitlement tables are complete
// (read-readiness.ts — boot/drain window), the view derives from the live
// legacy ConnectionGrant rows instead — the same rows exec's fallback
// matcher authorizes from — so a conversation's opt-ins never read as empty
// while its grants still execute. Lifecycle statuses live in the entitlement
// store (not readable yet), so legacy-derived entries serve `active`: a live
// legacy grant is exactly what V1 treated as usable consent.
//
// Response contract: docs/schemas/conversation-abilities.schema.json.

const paramsSchema = z.object({
  conversationId: z.string().min(1).max(256),
});

export async function conversationAbilitiesGetHandler(
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

  if (!(await isEntitlementReadModelReady())) {
    const grants = await prisma.connectionGrant.findMany({
      where: { conversationId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    res.status(200).json({
      abilities: grants.map((grant) => ({
        abilityId: normalizeAbilityId(grant.toolkit),
        conversationId: grant.conversationId,
        agentInboxId: grant.granteeInboxId,
        bundleIds: grant.bundleIds,
        extendedByInboxId:
          grant.ownerInboxId === "" ? null : grant.ownerInboxId,
        extendedByMe: grant.ownerAccountId === accountId,
        status: "active",
        createdAt: grant.createdAt,
        updatedAt: grant.updatedAt,
      })),
    });
    return;
  }

  const rows = await prisma.conversationAbility.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    include: {
      entitlement: {
        select: { abilityId: true, accountId: true, status: true },
      },
    },
  });

  res.status(200).json({
    abilities: rows.map((row) => ({
      abilityId: row.entitlement.abilityId,
      conversationId: row.conversationId,
      agentInboxId: row.agentInboxId,
      bundleIds: row.bundleIds,
      extendedByInboxId: row.extendedByInboxId,
      extendedByMe: row.entitlement.accountId === accountId,
      status: row.entitlement.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  });
}
