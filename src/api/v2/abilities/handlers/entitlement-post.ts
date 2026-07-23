import type { Request, Response } from "express";
import { z } from "zod";
import {
  getPublicAbilities,
  getServedAbilityVersion,
} from "@/api/v2/abilities/manifests.config";
import { createComposioService } from "@/api/v2/connections/composio.service";
import { prisma } from "@/utils/prisma";

// POST /v2/abilities/{abilityId}/entitlement — create or restart the caller's
// entitlement (docs/plans/abilities-entitlements.md, "Bind"). requireAccount.
//
// Idempotent per (account, ability). OAuth abilities start (or restart) the
// Composio link flow and answer { status, redirectUrl, connectionRequestId };
// auth-less abilities flip straight to active with null auth fields. The
// served status is the row's resulting status: a restart keeps an `active`
// entitlement active while the re-auth is in flight (the old credential still
// works until complete swaps it), every other prior state reads pending_auth.
// Binding is an explicit user action, so it clears a revocation tombstone.
//
// Response contract: docs/schemas/ability-entitlement-bind.schema.json.

const bodySchema = z.object({
  // Per-environment OAuth callback (e.g. "convos://connections/callback"),
  // exactly as V1 initiate accepts; falls back to the backend default.
  redirectUri: z.string().url().max(2048).optional(),
});

export { bodySchema as entitlementPostBodySchema };

const paramsSchema = z.object({ abilityId: z.string().min(1).max(128) });

export async function entitlementPostHandler(req: Request, res: Response) {
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
  const abilityId = params.data.abilityId.toLowerCase();
  const ability = getPublicAbilities().find((a) => a.id === abilityId);
  if (!ability) {
    // Hidden (unlaunched) manifests are not bindable either.
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

  if (ability.auth.type === "none") {
    await prisma.abilityEntitlement.upsert({
      where: { accountId_abilityId: { accountId, abilityId } },
      create: {
        accountId,
        abilityId,
        status: "active",
        abilityVersion: getServedAbilityVersion(abilityId),
      },
      update: {
        status: "active",
        revokedAt: null,
        abilityVersion: getServedAbilityVersion(abilityId),
      },
    });
    res.status(200).json({
      status: "active",
      redirectUrl: null,
      connectionRequestId: null,
    });
    return;
  }

  const service = createComposioService();
  if (!service) {
    res.status(503).json({ error: "Connections not configured" });
    return;
  }

  try {
    const authConfigId = await service.resolveAuthConfigId(abilityId);
    if (!authConfigId) {
      // The catalog offers the ability but Composio has no ENABLED auth
      // config — a backend configuration gap the client cannot fix.
      req.log.error(
        { accountId, abilityId },
        "[Abilities] bind: no ENABLED auth config for ability",
      );
      res.status(502).json({ code: "auth_config_unavailable" });
      return;
    }

    const request = await service.initiate({
      userId: accountId,
      authConfigId,
      callbackUrl: parsed.data.redirectUri,
    });

    const existing = await prisma.abilityEntitlement.findUnique({
      where: { accountId_abilityId: { accountId, abilityId } },
    });
    const keepActive = existing?.status === "active" && !existing.revokedAt;
    const status = keepActive ? "active" : "pending_auth";
    await prisma.abilityEntitlement.upsert({
      where: { accountId_abilityId: { accountId, abilityId } },
      create: {
        accountId,
        abilityId,
        status,
        abilityVersion: getServedAbilityVersion(abilityId),
      },
      update: {
        status,
        revokedAt: null,
        abilityVersion: getServedAbilityVersion(abilityId),
      },
    });

    req.log.info(
      { accountId, abilityId, status },
      "[Abilities] bind: entitlement upserted, auth flow started",
    );
    res.status(200).json({
      status,
      redirectUrl: request.redirectUrl ?? null,
      connectionRequestId: request.id,
    });
    return;
  } catch (error) {
    req.log.error({ error, accountId, abilityId }, "[Abilities] bind failed");
    res.status(502).json({ code: "initiate_failed" });
    return;
  }
}
