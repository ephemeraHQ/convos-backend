import type { Request, Response } from "express";
import { prisma } from "@/utils/prisma";

// Lists the caller's own (non-revoked) grants — served from the entitlement
// tables (the source of truth) in the V1 wire shape. Withdrawn opt-ins have
// no extension row, so "non-revoked" is simply "present"; ids and createdAt
// are the legacy grant's own (carried by the adapter/backfill), so clients
// can keep pairing list ids with DELETE /grants/:id.
//
// Rows a V2 write created without an extender inbox id are V1-invisible
// (the V1 shape requires ownerInboxId); V1 clients cannot represent them.
// connectionId is deliberately absent from the wire — a bearer capability
// that stays backend-side — and `actions` (raw Composio slugs) likewise:
// slugs are the backend-only security boundary, clients reason in bundle ids.
export async function grantsListHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId;
  if (!accountId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const rows = await prisma.conversationAbility.findMany({
    where: {
      entitlement: { is: { accountId } },
      extendedByInboxId: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      conversationId: true,
      agentInboxId: true,
      bundleIds: true,
      extendedByInboxId: true,
      expiresAt: true,
      createdAt: true,
      entitlement: { select: { abilityId: true } },
    },
  });

  res.status(200).json({
    grants: rows.map((row) => ({
      id: row.id,
      ownerInboxId: row.extendedByInboxId,
      granteeInboxId: row.agentInboxId,
      conversationId: row.conversationId,
      toolkit: row.entitlement.abilityId,
      bundleIds: row.bundleIds,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    })),
  });
}
