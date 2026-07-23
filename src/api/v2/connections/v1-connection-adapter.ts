import { normalizeAbilityId } from "@/api/v2/abilities/ability-id";
import {
  COMPOSIO_DERIVED_STATUS_RANK,
  toEntitlementStatus,
  type ComposioDerivedStatus,
} from "@/api/v2/abilities/entitlement-status";
import { getServedAbilityVersion } from "@/api/v2/abilities/manifests.config";
import type { ComposioService } from "@/api/v2/connections/composio.service";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

// Entitlement mirroring for the V1 connection lifecycle handlers
// (initiate / complete / delete). Without it, a V1 client's connect or
// disconnect would not reach the table-driven V2 catalog until the next
// reconciliation sweep.
//
// Every function here is best-effort by contract: it catches its own errors
// and only warn-logs, because the V1 wire responses must not change — the
// external operation already succeeded, and the reconciliation sweep
// converges anything missed. The two hard rules match the backfill's:
// explicit user actions (a new auth flow, a completed connect) may clear a
// revocation tombstone; derived state never does.

/**
 * A V1 auth flow started (POST /v2/connections/initiate). The entitlement
 * appears as pending_auth; an active entitlement stays active while the
 * re-auth is in flight (the old credential still works until complete).
 */
export async function noteV1AuthFlowStarted(args: {
  accountId: string;
  serviceId: string;
}): Promise<void> {
  const abilityId = normalizeAbilityId(args.serviceId);
  try {
    const existing = await prisma.abilityEntitlement.findUnique({
      where: { accountId_abilityId: { accountId: args.accountId, abilityId } },
    });
    if (!existing) {
      await prisma.abilityEntitlement.create({
        data: {
          accountId: args.accountId,
          abilityId,
          status: "pending_auth",
          abilityVersion: getServedAbilityVersion(abilityId),
        },
      });
      return;
    }
    if (existing.status === "active" && !existing.revokedAt) return;
    await prisma.abilityEntitlement.update({
      where: { id: existing.id },
      data: { status: "pending_auth", revokedAt: null },
    });
  } catch (error) {
    logger.warn(
      { error, accountId: args.accountId, abilityId },
      "[Abilities] V1 initiate: entitlement mirror failed (reconciliation will converge)",
    );
  }
}

/**
 * A V1 connect completed with verified ownership (POST
 * /v2/connections/complete): the entitlement is active and backed by the
 * verified credential.
 */
export async function noteV1ConnectionCompleted(args: {
  accountId: string;
  connectionId: string;
  toolkitSlug: string;
}): Promise<void> {
  const abilityId = normalizeAbilityId(args.toolkitSlug);
  try {
    await prisma.abilityEntitlement.upsert({
      where: { accountId_abilityId: { accountId: args.accountId, abilityId } },
      create: {
        accountId: args.accountId,
        abilityId,
        status: "active",
        externalConnectionId: args.connectionId,
        abilityVersion: getServedAbilityVersion(abilityId),
      },
      update: {
        status: "active",
        externalConnectionId: args.connectionId,
        revokedAt: null,
      },
    });
  } catch (error) {
    logger.warn(
      { error, accountId: args.accountId, abilityId },
      "[Abilities] V1 complete: entitlement mirror failed (reconciliation will converge)",
    );
  }
}

/**
 * A V1 disconnect deleted one connection (DELETE /v2/connections/:id). The
 * entitlement — when one exists — is re-derived from the connections that
 * remain: none left means the user disconnected the service (revoked
 * tombstone; V1 semantics deliberately leave grants in place, so the check
 * still resolves them and fails downstream with connection_not_found exactly
 * as before); survivors re-derive status from the most usable one. Existing
 * tombstones are never resurrected here.
 */
export async function noteV1ConnectionDeleted(args: {
  accountId: string;
  toolkitSlug: string;
  service: ComposioService;
}): Promise<void> {
  const abilityId = normalizeAbilityId(args.toolkitSlug);
  try {
    const existing = await prisma.abilityEntitlement.findUnique({
      where: { accountId_abilityId: { accountId: args.accountId, abilityId } },
    });
    if (!existing || existing.revokedAt) return;

    const { items } = await args.service.listForUser(args.accountId);
    const remaining = items.filter(
      (item) => item.toolkit.slug.toLowerCase() === abilityId,
    );
    if (remaining.length === 0) {
      await prisma.abilityEntitlement.update({
        where: { id: existing.id },
        data: {
          status: "revoked",
          revokedAt: new Date(),
          externalConnectionId: null,
        },
      });
      return;
    }

    let best: { status: ComposioDerivedStatus; connectionId: string } | null =
      null;
    for (const item of remaining) {
      const status = toEntitlementStatus(item.status, logger);
      if (
        !best ||
        COMPOSIO_DERIVED_STATUS_RANK[status] <
          COMPOSIO_DERIVED_STATUS_RANK[best.status]
      ) {
        best = { status, connectionId: item.id };
      }
    }
    if (!best) return;
    await prisma.abilityEntitlement.update({
      where: { id: existing.id },
      data: { status: best.status, externalConnectionId: best.connectionId },
    });
  } catch (error) {
    logger.warn(
      { error, accountId: args.accountId, abilityId },
      "[Abilities] V1 delete: entitlement mirror failed (reconciliation will converge)",
    );
  }
}
