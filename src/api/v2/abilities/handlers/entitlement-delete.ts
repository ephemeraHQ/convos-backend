import type { Request, Response } from "express";
import { z } from "zod";
import { normalizeAbilityId } from "@/api/v2/abilities/ability-id";
import { ABILITY_MANIFESTS } from "@/api/v2/abilities/manifests.config";
import { createComposioService } from "@/api/v2/connections/composio.service";
import { prisma } from "@/utils/prisma";

// DELETE /v2/abilities/{abilityId}/entitlement — revoke
// (docs/plans/abilities-entitlements.md, "Bind"). requireAccount.
//
// Order matters: the external teardown runs FIRST, and a Composio failure —
// including Composio being UNCONFIGURED on this replica — answers 5xx with
// the entitlement untouched: tombstoning a row whose credential may still
// exist would lie to the user (and the backfill's never-touch-revoked rule
// means reconciliation could not repair it). A missing service is treated
// exactly like an outage, because "not configured here" says nothing about
// credentials created elsewhere; only an ability the manifest declares
// auth-less, with no recorded external credential, may tear down locally
// without the service. On success: every Composio connection for the toolkit
// is deleted (the multi-credential rule — duplicates go with the
// entitlement), then in ONE transaction the conversation extensions are
// deleted, legacy V1 grants are soft-revoked (rolling-deploy symmetry), and
// the row is kept as an audit tombstone (status revoked, revokedAt,
// credential ref cleared).
//
// Idempotent: deleting an already-revoked entitlement re-runs the teardown
// (harmlessly) and answers 204 again; only a never-bound ability is 404.
// The ability id is matched against the caller's rows, not the catalog, so a
// hidden or removed ability can still be revoked.

const paramsSchema = z.object({ abilityId: z.string().min(1).max(128) });

export async function entitlementDeleteHandler(req: Request, res: Response) {
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
  const abilityId = normalizeAbilityId(params.data.abilityId);
  const entitlement = await prisma.abilityEntitlement.findUnique({
    where: { accountId_abilityId: { accountId, abilityId } },
  });
  if (!entitlement) {
    res.status(404).json({ code: "not_found" });
    return;
  }

  // External teardown first (see the module comment). Skipping it is allowed
  // only when the manifest says the ability never has an external credential
  // AND none was ever recorded; otherwise an unconfigured service is an
  // outage — 503, row untouched, never a tombstone over a live credential.
  const manifest = ABILITY_MANIFESTS.find((m) => m.id === abilityId);
  const authless =
    manifest?.auth.type === "none" && entitlement.externalConnectionId === null;
  const service = createComposioService();
  if (!service && !authless) {
    req.log.error(
      { accountId, abilityId },
      "[Abilities] revoke: Composio not configured — refusing local-only teardown",
    );
    res.status(503).json({ error: "Connections not configured" });
    return;
  }
  const deletedConnectionIds = new Set<string>();
  if (service) {
    try {
      const { items } = await service.listForUser(accountId);
      const matching = items.filter(
        (item) => item.toolkit.slug.toLowerCase() === abilityId,
      );
      for (const item of matching) {
        await service.delete(item.id);
        deletedConnectionIds.add(item.id);
      }
      if (matching.length > 0) {
        req.log.info(
          { accountId, abilityId, deleted: matching.length },
          "[Abilities] revoke: Composio connections deleted",
        );
      }
    } catch (error) {
      req.log.error(
        { error, accountId, abilityId },
        "[Abilities] revoke: external teardown failed — entitlement untouched",
      );
      res.status(502).json({ code: "revoke_failed" });
      return;
    }
  }

  // Local teardown in one transaction: extensions, legacy mirror, tombstone
  // move together or not at all — no divergent half-revoked state. The
  // tombstone runs first because its row update takes the entitlement's row
  // lock: a concurrent extend PUT locks the same row before writing, so the
  // two serialize instead of racing (a PUT that wins commits first and its
  // fresh extension dies in the deleteMany below; one that loses re-reads a
  // tombstone and answers 409).
  await prisma.$transaction(async (tx) => {
    await tx.abilityEntitlement.update({
      where: { id: entitlement.id },
      data: {
        status: "revoked",
        revokedAt: entitlement.revokedAt ?? new Date(),
        externalConnectionId: null,
      },
    });
    await tx.conversationAbility.deleteMany({
      where: { entitlementId: entitlement.id },
    });
    await tx.connectionGrant.updateMany({
      where: {
        ownerAccountId: accountId,
        toolkit: { equals: abilityId, mode: "insensitive" },
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  });

  // A bind/complete racing this revoke can create a credential after the
  // teardown listed the account's connections but before the tombstone
  // landed — invisible to the loop above, live after the 204. One re-list
  // closes that window; a failure here only logs (the row is already
  // tombstoned, and a retried DELETE converges).
  if (service) {
    try {
      const { items } = await service.listForUser(accountId);
      // Ids already deleted above are skipped: only a connection created
      // since the first list (a concurrent bind) is a straggler — an
      // eventually-consistent list echoing a deleted id must not be
      // re-deleted.
      const stragglers = items.filter(
        (item) =>
          item.toolkit.slug.toLowerCase() === abilityId &&
          !deletedConnectionIds.has(item.id),
      );
      for (const item of stragglers) {
        await service.delete(item.id);
      }
      if (stragglers.length > 0) {
        req.log.info(
          { accountId, abilityId, deleted: stragglers.length },
          "[Abilities] revoke: straggler connections from a concurrent bind deleted",
        );
      }
    } catch (error) {
      req.log.error(
        { error, accountId, abilityId },
        "[Abilities] revoke: straggler re-check failed — a concurrently bound credential may survive; a retried DELETE converges",
      );
    }
  }

  req.log.info({ accountId, abilityId }, "[Abilities] entitlement revoked");
  res.status(204).end();
}
