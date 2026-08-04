import type { Request, Response } from "express";
import { normalizeAbilityId } from "@/api/v2/abilities/ability-id";
import type { EntitlementStatus as TableEntitlementStatus } from "@/api/v2/abilities/entitlement-status";
import {
  getCatalogVersion,
  getPublicAbilities,
  type PublicAbility,
} from "@/api/v2/abilities/manifests.config";
import { isEntitlementReadModelReady } from "@/api/v2/abilities/read-readiness";
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
//     but entitlement state could not be read: a store failure, or the
//     entitlement tables are still converging (read-readiness.ts — boot/drain
//     window; serving them then would report "not entitled" to accounts whose
//     rows have not been backfilled yet). Abilities then carry NO
//     `entitlement` key and clients keep their last-known state instead of
//     rendering "not connected". The catalog itself is code config and stays
//     servable.

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
    if (await isEntitlementReadModelReady()) {
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
    } else {
      // Boot/drain window: rows stay null so the response carries
      // entitlementsUnavailable — an authoritative `entitlement: null` here
      // would read as "not connected" for accounts the backfill has not
      // reached yet.
      req.log.info(
        { accountId },
        "[Abilities] entitlement tables not ready — serving entitlementsUnavailable",
      );
    }
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
  // deletes extensions, so tombstones naturally count 0. Case-variant rows
  // folding onto one wire id keep the most usable status but UNION their
  // conversation sets — mid-reconciliation, each variant's live extensions
  // authorize, so the folded count must cover all of them.
  const now = new Date();
  const foldedByAbility = new Map<
    string,
    { status: EntitlementStatus; conversations: Set<string> }
  >();
  for (const row of rows) {
    const id = normalizeAbilityId(row.abilityId);
    const status = row.status as EntitlementStatus;
    const conversations = new Set<string>();
    for (const extension of row.extensions) {
      if (extension.expiresAt === null || extension.expiresAt > now) {
        conversations.add(extension.conversationId);
      }
    }
    const prev = foldedByAbility.get(id);
    if (!prev) {
      foldedByAbility.set(id, { status, conversations });
      continue;
    }
    for (const conversationId of conversations) {
      prev.conversations.add(conversationId);
    }
    if (WIRE_STATUS_RANK[status] < WIRE_STATUS_RANK[prev.status]) {
      prev.status = status;
    }
  }
  const entitlementByAbility = new Map<string, ServedEntitlement>();
  for (const [id, folded] of foldedByAbility) {
    entitlementByAbility.set(id, {
      status: folded.status,
      extensionCount: folded.conversations.size,
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
