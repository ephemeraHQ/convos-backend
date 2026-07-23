import type { Request, Response } from "express";
import { z } from "zod";
import { revokeConnectionGrantById } from "@/api/v2/connections/v1-grant-adapter";

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

  // Adapter over the entitlement tables (see v1-grant-adapter.ts): the legacy
  // row is soft-revoked and the extension (sharing its id) is deleted.
  const count = await revokeConnectionGrantById({
    accountId,
    grantId: parsed.data.id,
  });

  if (count === 0) {
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
