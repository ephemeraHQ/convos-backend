import type { Request, Response } from "express";
import { z } from "zod";
import { revokeConnectionGrantsByNaturalKey } from "@/api/v2/connections/v1-grant-adapter";

// Revoke by NATURAL KEY rather than by grant id. iOS may not hold the backend
// grant id (the create succeeded but the id-save failed, or the grant predates
// this flow), which would otherwise strand a live grant the user thinks they
// revoked. The owner is taken from the JWT, so a caller can only ever revoke
// their own grants. Filters narrow the scope:
//   { toolkit }                                   → disconnect: every grant for it
//   { toolkit, conversationId }                   → un-share in one conversation
//   { toolkit, conversationId, granteeInboxId }   → one agent
const bodySchema = z.object({
  toolkit: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(256).optional(),
  granteeInboxId: z.string().min(1).max(256).optional(),
});

export async function grantsRevokeHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId;
  if (!accountId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const { toolkit, conversationId, granteeInboxId } = parsed.data;

  // Adapter over the entitlement tables (see v1-grant-adapter.ts): legacy
  // rows are soft-deleted (revokedAt; already-revoked rows excluded so the
  // count reflects what this call changed) and the matching extensions are
  // deleted. Scoped to the caller's own account either way.
  const revoked = await revokeConnectionGrantsByNaturalKey({
    accountId,
    toolkit,
    conversationId,
    granteeInboxId,
  });

  req.log.info(
    {
      accountId,
      toolkit,
      conversationId,
      granteeInboxId,
      revoked,
    },
    "[Composio] grants revoked by natural key",
  );
  res.status(200).json({ revoked });
}
