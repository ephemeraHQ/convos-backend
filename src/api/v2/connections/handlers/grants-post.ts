import type { Request, Response } from "express";
import { z } from "zod";
import { getServiceConfig } from "@/api/v2/connections/bundles.config";
import { issueConnectionGrant } from "@/api/v2/connections/v1-grant-adapter";

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
  // Allowed action slugs; empty ⇒ whole toolkit. Legacy/transition — superseded
  // by bundleIds, kept as a fallback so older clients keep working.
  actions: z.array(z.string().min(1).max(128)).max(128).optional(),
  // Granted permission-bundle ids (e.g. "calendar.events"). The backend resolves
  // these to Composio actions at exec; clients never send slugs.
  bundleIds: z.array(z.string().min(1).max(128)).max(128).optional(),
  // Catalog service version the client granted against. Stored for
  // audit/telemetry only — exec resolves bundles against the current catalog.
  serviceVersion: z.number().int().nonnegative().optional(),
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
    bundleIds,
    serviceVersion,
    expiresAt,
  } = parsed.data;

  // Defense in depth (on top of exec failing closed on unresolvable bundles):
  // reject unknown bundle ids at write time so a stale/typo'd client gets an
  // actionable 400 instead of a grant that silently authorizes nothing. Every
  // bundle id must exist in the catalog for this toolkit; bundleIds against a
  // toolkit absent from the catalog are equally unknown. Toolkits outside the
  // catalog stay grantable with empty/absent bundleIds (legacy path).
  // Deprecated bundles are deliberately still grantable: an old app holding a
  // cached catalog (up to its TTL) may legitimately round-trip one, and the
  // grant still resolves at exec — so rejecting it would only break old
  // clients without protecting anything.
  if (bundleIds && bundleIds.length > 0) {
    const svc = getServiceConfig(toolkit);
    const known = new Set(svc?.bundles.map((b) => b.id) ?? []);
    const unknown = bundleIds.find((id) => !known.has(id));
    if (unknown !== undefined) {
      req.log.warn(
        { accountId, toolkit, bundleId: unknown },
        "[Composio] grant rejected: unknown bundle id",
      );
      res.status(400).json({ code: "unknown_bundle", bundleId: unknown });
      return;
    }
  }

  // Adapter over the entitlement tables (see v1-grant-adapter.ts): the
  // legacy row keeps its exact upsert semantics — one grant per (owner,
  // grantee, conversation, toolkit); re-approval refreshes scope/expiry and
  // clears a prior revocation — and the same fact lands in the entitlement +
  // extension tables that every new reader consumes.
  const grant = await issueConnectionGrant({
    accountId,
    ownerInboxId,
    granteeInboxId,
    conversationId,
    toolkit,
    actions,
    bundleIds,
    serviceVersion,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  });

  req.log.info(
    { accountId, grantId: grant.id, granteeInboxId, conversationId, toolkit },
    "[Composio] grant issued",
  );
  res.status(200).json({ id: grant.id });
}
