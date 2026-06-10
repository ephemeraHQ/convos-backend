import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const paramsSchema = z.object({ id: z.string().uuid() });

// Revoke a grant. Soft-delete (revokedAt) to keep an audit trail and to match
// the iOS connection_event.revoked signal. Scoped to the caller's own grants —
// the WHERE includes ownerAccountId, so a caller can never revoke another
// account's grant.
export async function grantsDeleteHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId;
  if (!accountId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ code: "invalid_request" });
    return;
  }

  const result = await prisma.connectionGrant.updateMany({
    where: {
      id: parsed.data.id,
      ownerAccountId: accountId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  if (result.count === 0) {
    // Not found, not owned, or already revoked — all indistinguishable to the
    // caller on purpose (don't leak existence of another account's grant).
    res.status(404).json({ code: "not_found" });
    return;
  }

  req.log.info(
    { accountId, grantId: parsed.data.id },
    "[Composio] grant revoked",
  );
  res.status(204).end();
}
