import type { Request, Response } from "express";
import { z } from "zod";
import { normalizeAbilityId } from "@/api/v2/abilities/ability-id";
import { toEntitlementStatus } from "@/api/v2/abilities/entitlement-status";
import {
  getPublicAbilities,
  getServedAbilityVersion,
} from "@/api/v2/abilities/manifests.config";
import { createComposioService } from "@/api/v2/connections/composio.service";
import { prisma } from "@/utils/prisma";

// POST /v2/abilities/{abilityId}/entitlement/complete — post-callback
// ownership verification, mirroring V1 /v2/connections/complete: the
// connection must belong to the caller's own account (verified by listing the
// caller's connections, never by trusting the id), to this ability's toolkit,
// and Composio must consider it ACTIVE — a complete fired right after
// initiate can find the owned connection still INITIALIZING/INITIATED, and
// persisting `active` for it would let the catalog and conversation PUT
// treat an unfinished OAuth as a usable credential. A non-active connection
// answers a retryable 409 auth_incomplete with the mapped status and leaves
// the entitlement untouched (it stays pending_auth from bind). On success
// the entitlement flips to active and records the credential as its
// backend-only externalConnectionId. requireAccount.
//
// Lenient about a missing row (upsert): the OAuth callback can race a
// restart, and completing a bind the backend lost track of is strictly
// convergent. Verified completion is an explicit user action, so it clears a
// revocation tombstone.
//
// Response contract: docs/schemas/ability-entitlement-complete.schema.json.

const bodySchema = z.object({
  connectionRequestId: z.string().min(1).max(256),
});

export { bodySchema as entitlementCompleteBodySchema };

const paramsSchema = z.object({ abilityId: z.string().min(1).max(128) });

export async function entitlementCompleteHandler(req: Request, res: Response) {
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
  const ability = getPublicAbilities().find((a) => a.id === abilityId);
  if (!ability) {
    res.status(404).json({ code: "unknown_ability" });
    return;
  }

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", issues: parsed.error.issues });
    return;
  }

  const service = createComposioService();
  if (!service) {
    res.status(503).json({ error: "Connections not configured" });
    return;
  }

  try {
    // External I/O never runs while database locks are held: the Composio
    // ownership read happens BEFORE the transaction (bounded by the service's
    // per-call timeout), and the transaction keeps only lock -> tombstone
    // re-check -> activate. The resurrect race stays closed by the re-check:
    // the pre-read snapshots the row's revocation state, and a NEW tombstone
    // observed under the row lock means a revoke committed after the
    // credential was verified -- its teardown deleted that credential, so
    // activating from the stale read would resurrect a dead credential.
    // An UNCHANGED tombstone (same revokedAt as the pre-read) is the
    // by-design resurrection path: the credential provably exists after the
    // revoke, and completion is an explicit user action.
    const pre = await prisma.abilityEntitlement.findUnique({
      where: { accountId_abilityId: { accountId, abilityId } },
    });

    const owned = await upstream(() =>
      service.getIfOwned({
        connectionId: parsed.data.connectionRequestId,
        userId: accountId,
      }),
    );
    if (!owned) {
      res.status(403).json({ code: "connection_not_owned" });
      return;
    }
    if (owned.toolkit.slug.toLowerCase() !== abilityId) {
      // A real connection of the caller's, but for a different toolkit than
      // the ability being completed -- reject rather than mis-bind.
      res.status(409).json({ code: "ability_mismatch" });
      return;
    }
    const connectionStatus = toEntitlementStatus(owned.status, req.log);
    if (connectionStatus !== "active") {
      req.log.info(
        { accountId, abilityId, composioStatus: owned.status },
        "[Abilities] complete: connection not active yet -- auth_incomplete",
      );
      res
        .status(409)
        .json({ code: "auth_incomplete", status: connectionStatus });
      return;
    }

    type Outcome =
      | { kind: "revoked_during_complete" }
      | {
          kind: "active";
          prior: {
            status: string;
            revokedAt: Date | null;
            externalConnectionId: string | null;
          } | null;
        };
    const outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
      await tx.$queryRaw`SELECT "id" FROM "AbilityEntitlement" WHERE "accountId" = ${accountId}::uuid AND "abilityId" = ${abilityId} FOR UPDATE`;
      const prior = await tx.abilityEntitlement.findUnique({
        where: { accountId_abilityId: { accountId, abilityId } },
      });
      const priorRevokedAtMs = prior?.revokedAt?.getTime() ?? null;
      const preRevokedAtMs = pre?.revokedAt?.getTime() ?? null;
      if (priorRevokedAtMs !== null && priorRevokedAtMs !== preRevokedAtMs) {
        return { kind: "revoked_during_complete" };
      }
      await tx.abilityEntitlement.upsert({
        where: { accountId_abilityId: { accountId, abilityId } },
        create: {
          accountId,
          abilityId,
          status: "active",
          externalConnectionId: owned.id,
          abilityVersion: getServedAbilityVersion(abilityId),
        },
        update: {
          status: "active",
          externalConnectionId: owned.id,
          revokedAt: null,
        },
      });
      return { kind: "active", prior };
    });

    if (outcome.kind === "revoked_during_complete") {
      req.log.warn(
        { accountId, abilityId },
        "[Abilities] complete: entitlement revoked while verifying -- refusing activation",
      );
      res.status(403).json({ code: "connection_not_owned" });
      return;
    }

    // Residual window the row lock cannot cover: a DELETE that committed
    // before the pre-read deletes stragglers AFTER its own commit -- its
    // sweep can tear this credential down right after the activation above.
    // Re-verify post-commit; on failure a guarded restore (matching exactly
    // what this handler wrote, so a delete that already re-tombstoned is
    // never clobbered) puts the prior state back.
    const still = await upstream(() =>
      service.getIfOwned({
        connectionId: parsed.data.connectionRequestId,
        userId: accountId,
      }),
    );
    if (!still || toEntitlementStatus(still.status, req.log) !== "active") {
      await prisma.abilityEntitlement.updateMany({
        where: {
          accountId,
          abilityId,
          status: "active",
          externalConnectionId: owned.id,
        },
        data: outcome.prior
          ? {
              status: outcome.prior.status,
              revokedAt: outcome.prior.revokedAt,
              externalConnectionId: outcome.prior.externalConnectionId,
            }
          : { status: "expired", externalConnectionId: null },
      });
      req.log.warn(
        { accountId, abilityId },
        "[Abilities] complete: connection gone after persist (concurrent revoke) -- restored prior state",
      );
      res.status(403).json({ code: "connection_not_owned" });
      return;
    }

    req.log.info(
      { accountId, abilityId },
      "[Abilities] complete: entitlement active",
    );
    res.status(200).json({ status: "active" });
    return;
  } catch (error) {
    // Upstream (Composio) failures are the gateway's fault -- 502; anything
    // else is an internal failure -- 500. Same body shape either way, so
    // clients keep one retryable error surface.
    const upstreamFailure = error instanceof UpstreamCompleteError;
    req.log.error(
      {
        error: upstreamFailure ? (error.cause ?? error) : error,
        accountId,
        abilityId,
        upstreamFailure,
      },
      "[Abilities] complete failed",
    );
    res.status(upstreamFailure ? 502 : 500).json({ code: "complete_failed" });
    return;
  }
}

/** Marks a failure as coming from the upstream Composio call (-> 502). */
class UpstreamCompleteError extends Error {
  constructor(cause: unknown) {
    super("upstream complete call failed");
    this.name = "UpstreamCompleteError";
    this.cause = cause;
  }
}

async function upstream<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new UpstreamCompleteError(error);
  }
}
