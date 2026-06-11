import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

// iOS issues a grant when the owner approves a capability request. The owner is
// taken from the authenticated JWT (res.locals.accountId), never the body, so a
// caller can only grant access to their own connections.
const bodySchema = z.object({
  // The owner's own XMTP inbox. A pointer the agent resolves against; it is
  // bound to ownerAccountId, so a wrong value only breaks the owner's own
  // resolution — it cannot reach another account's data.
  ownerInboxId: z.string().min(1).max(256),
  // The agent allowed to act (iOS #812 grantedToInboxId).
  granteeInboxId: z.string().min(1).max(256),
  conversationId: z.string().min(1).max(256),
  toolkit: z.string().min(1).max(128),
  // Allowed action slugs; empty ⇒ whole toolkit.
  actions: z.array(z.string().min(1).max(128)).max(128).optional(),
  expiresAt: z.string().datetime().optional(),
});

// NOTE: we deliberately do NOT accept a `connectionId` from the client. A
// connected-account id is a Composio bearer capability and is NOT cross-checked
// against the owner — accepting one would let a caller pin a *victim's*
// connection to their own grant. exec resolves the connection server-side from
// (ownerAccountId, toolkit), which can only ever return the owner's own
// connections. Any `connectionId` field in the body is silently ignored.

export async function grantsPostHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId;
  if (!accountId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn(
      { accountId, issues: parsed.error.issues },
      "[Composio] grant body validation failed",
    );
    res
      .status(400)
      .json({ code: "invalid_request", issues: parsed.error.issues });
    return;
  }

  const {
    ownerInboxId,
    granteeInboxId,
    conversationId,
    toolkit,
    actions,
    expiresAt,
  } = parsed.data;

  // One grant per (owner, grantee, conversation, toolkit): re-approval updates
  // the same row (refreshes scope/expiry, clears a prior revocation).
  const grant = await prisma.connectionGrant.upsert({
    where: {
      ownerAccountId_granteeInboxId_conversationId_toolkit: {
        ownerAccountId: accountId,
        granteeInboxId,
        conversationId,
        toolkit,
      },
    },
    create: {
      ownerAccountId: accountId,
      ownerInboxId,
      granteeInboxId,
      conversationId,
      toolkit,
      actions: actions ?? [],
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    },
    update: {
      ownerInboxId,
      actions: actions ?? [],
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      revokedAt: null,
    },
  });

  req.log.info(
    { accountId, grantId: grant.id, granteeInboxId, conversationId, toolkit },
    "[Composio] grant issued",
  );
  res.status(200).json({ id: grant.id });
}
