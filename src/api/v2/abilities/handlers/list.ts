import type { Request, Response } from "express";
import type { EntitlementStatus as TableEntitlementStatus } from "@/api/v2/abilities/entitlement-status";
import {
  getCatalogVersion,
  getPublicAbilities,
  type PublicAbility,
} from "@/api/v2/abilities/manifests.config";
import { prisma } from "@/utils/prisma";

// GET /v2/abilities — the ability catalog merged with the caller's
// entitlement state (docs/plans/abilities-entitlements.md, "Enumerate").
//
// JWT-only, NOT account-scoped: a device-only token gets the catalog with
// `entitlement: null` everywhere (browsable, not entitleable). With an
// account on the JWT, each ability carries the caller's entitlement state.
//
// Entitlement state comes from the AbilityEntitlement tables — the
// backend-owned source of truth — never from a per-request Composio call:
// status transitions originate server-side (lifecycle endpoints, backfill /
// reconciliation, later the revalidation job) and clients only ever read
// them. `extensionCount` is the number of distinct conversations with live
// extensions (the same expiry predicate the check enforces).
//
// Wire contract (see docs/schemas/abilities.schema.json):
//   - `entitlement` object -> entitled; `status` says whether it is usable
//   - `entitlement: null`  -> not entitled (or no account on the token)
//   - top-level `entitlementsUnavailable: true` -> the caller has an account
//     but entitlement state could not be read (store failure); abilities then
//     carry NO `entitlement` key and clients keep their last-known state
//     instead of rendering "not connected". The catalog itself is code
//     config and stays servable.

export type EntitlementStatus = TableEntitlementStatus;

type ServedEntitlement = {
  status: EntitlementStatus;
  extensionCount: number;
};

type ServedAbility = PublicAbility & {
  entitlement?: ServedEntitlement | null;
};

// Should two rows ever fold onto one wire ability id (a case-variant legacy
// toolkit next to the canonical id), the most usable status wins.
const WIRE_STATUS_RANK: Record<EntitlementStatus, number> = {
  active: 0,
  pending_auth: 1,
  needs_reauth: 2,
  expired: 3,
  revoked: 4,
};

type EntitlementRow = {
  abilityId: string;
  status: string;
  extensions: Array<{ conversationId: string; expiresAt: Date | null }>;
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

  let rows: EntitlementRow[] | null = null;
  try {
    rows = await prisma.abilityEntitlement.findMany({
      where: { accountId },
      select: {
        abilityId: true,
        status: true,
        extensions: {
          select: { conversationId: true, expiresAt: true },
        },
      },
    });
  } catch (error) {
    // Leave rows null: entitlement state is unknowable, so the response
    // carries entitlementsUnavailable and omits every `entitlement` key per
    // the contract — the catalog must stay servable.
    req.log.error({ error, accountId }, "[Abilities] entitlement read failed");
  }

  if (!rows) {
    res.status(200).json({
      catalogVersion: getCatalogVersion(),
      entitlementsUnavailable: true,
      abilities: catalog.map((ability): ServedAbility => ({ ...ability })),
    });
    return;
  }

  // Extension counts mirror the check's live predicate: non-expired, so the
  // catalog never counts a conversation the check would deny. Revocation
  // deletes extensions, so tombstones naturally count 0.
  const now = new Date();
  const entitlementByAbility = new Map<string, ServedEntitlement>();
  for (const row of rows) {
    const id = row.abilityId.toLowerCase();
    const status = row.status as EntitlementStatus;
    const conversations = new Set<string>();
    for (const extension of row.extensions) {
      if (extension.expiresAt === null || extension.expiresAt > now) {
        conversations.add(extension.conversationId);
      }
    }
    const prev = entitlementByAbility.get(id);
    if (prev && WIRE_STATUS_RANK[prev.status] <= WIRE_STATUS_RANK[status]) {
      continue;
    }
    entitlementByAbility.set(id, {
      status,
      extensionCount: conversations.size,
    });
  }

  res.status(200).json({
    catalogVersion: getCatalogVersion(),
    abilities: catalog.map((ability): ServedAbility => {
      const entitlement = entitlementByAbility.get(ability.id);
      return { ...ability, entitlement: entitlement ?? null };
    }),
  });
}
