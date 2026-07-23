import type { Request, Response } from "express";
import {
  COMPOSIO_DERIVED_STATUS_RANK,
  KNOWN_COMPOSIO_STATUSES,
  toEntitlementStatus,
  type ComposioDerivedStatus,
} from "@/api/v2/abilities/entitlement-status";
import {
  getCatalogVersion,
  getPublicAbilities,
  type PublicAbility,
} from "@/api/v2/abilities/manifests.config";
import { createComposioService } from "@/api/v2/connections/composio.service";
import { prisma } from "@/utils/prisma";

// GET /v2/abilities — the ability catalog merged with the caller's
// entitlement state (docs/plans/abilities-entitlements.md, "Enumerate").
//
// JWT-only, NOT account-scoped: a device-only token gets the catalog with
// `entitlement: null` everywhere (browsable, not entitleable). With an
// account on the JWT, each ability carries the caller's entitlement state.
//
// Entitlement state is currently derived from the V1 stores (Composio
// connected accounts + ConnectionGrant rows). The dedicated entitlement
// tables will replace this adapter without changing the wire shape.
//
// Wire contract (see docs/schemas/abilities.schema.json):
//   - `entitlement` object -> entitled; `status` says whether it is usable
//   - `entitlement: null`  -> not entitled (or no account on the token)
//   - top-level `entitlementsUnavailable: true` -> the caller has an account
//     but entitlement state could not be determined (Composio lookup failed
//     or was truncated); abilities then carry NO `entitlement` key and
//     clients keep their last-known state instead of rendering
//     "not connected".

// The V1-derived read path emits only the Composio-derivable subset
// (pending_auth | active | expired); the mapping and rank live in
// entitlement-status.ts, shared with the backfill and the V1 adapters.
export type EntitlementStatus = ComposioDerivedStatus;

type ServedEntitlement = {
  status: EntitlementStatus;
  extensionCount: number;
};

type ServedAbility = PublicAbility & {
  entitlement?: ServedEntitlement | null;
};

export async function abilitiesListHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId;
  const catalog = getPublicAbilities();

  // The same URL serves a different body depending on the JWT (device-only vs
  // account), and iOS URLCache keys by URL — a cached device-only body could
  // be replayed after sign-in. So unlike GET /v2/connections/services (whose
  // response is identical for every caller), every response here is no-store.
  res.setHeader("Cache-Control", "no-store");

  if (!accountId) {
    res.status(200).json({
      catalogVersion: getCatalogVersion(),
      abilities: catalog.map(
        (ability): ServedAbility => ({ ...ability, entitlement: null }),
      ),
    });
    return;
  }

  let statusByAbility: Map<string, EntitlementStatus> | null = null;
  const service = createComposioService();
  if (service) {
    try {
      const { items } = await service.listForUser(accountId);
      statusByAbility = new Map();
      for (const item of items) {
        const id = item.toolkit.slug.toLowerCase();
        if (!KNOWN_COMPOSIO_STATUSES.has(item.status)) {
          req.log.warn(
            { accountId, composioStatus: item.status },
            "[Abilities] Unknown Composio status — mapping to expired",
          );
        }
        const status = toEntitlementStatus(item.status);
        const prev = statusByAbility.get(id);
        if (
          !prev ||
          COMPOSIO_DERIVED_STATUS_RANK[status] <
            COMPOSIO_DERIVED_STATUS_RANK[prev]
        ) {
          statusByAbility.set(id, status);
        }
      }
    } catch (error) {
      // Leave statusByAbility null: entitlement state is unknowable, so the
      // response carries entitlementsUnavailable and omits every
      // `entitlement` key per the contract.
      req.log.error({ error, accountId }, "[Abilities] Composio list failed");
    }
  }

  if (!statusByAbility) {
    res.status(200).json({
      catalogVersion: getCatalogVersion(),
      entitlementsUnavailable: true,
      abilities: catalog.map((ability): ServedAbility => ({ ...ability })),
    });
    return;
  }

  // Extension counts mirror exec's live-grant predicate: non-revoked and
  // non-expired, so the catalog never counts a conversation exec would deny.
  const now = new Date();
  const grants = await prisma.connectionGrant.findMany({
    where: {
      ownerAccountId: accountId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { toolkit: true, conversationId: true },
  });
  const conversationsByAbility = new Map<string, Set<string>>();
  for (const grant of grants) {
    const id = grant.toolkit.toLowerCase();
    const set = conversationsByAbility.get(id) ?? new Set<string>();
    set.add(grant.conversationId);
    conversationsByAbility.set(id, set);
  }

  const entitlementByAbility = statusByAbility;
  res.status(200).json({
    catalogVersion: getCatalogVersion(),
    abilities: catalog.map((ability): ServedAbility => {
      const status = entitlementByAbility.get(ability.id);
      if (!status) return { ...ability, entitlement: null };
      const conversations = conversationsByAbility.get(ability.id);
      return {
        ...ability,
        entitlement: {
          status,
          extensionCount: conversations ? conversations.size : 0,
        },
      };
    }),
  });
}
