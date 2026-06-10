import type { Request, Response } from "express";
import { prisma } from "@/utils/prisma";

// Lists the caller's own (non-revoked) grants. connectionId is deliberately
// omitted from the wire — it is a bearer capability that stays backend-side.
export async function grantsListHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId;
  if (!accountId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const grants = await prisma.connectionGrant.findMany({
    where: { ownerAccountId: accountId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      ownerInboxId: true,
      granteeInboxId: true,
      conversationId: true,
      toolkit: true,
      actions: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  res.status(200).json({ grants });
}
