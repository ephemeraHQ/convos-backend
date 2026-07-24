import type {
  ConnectionGrant,
  ConversationAbility,
  Prisma,
} from "@prisma/client";
import { normalizeAbilityId } from "@/api/v2/abilities/ability-id";
import { getServedAbilityVersion } from "@/api/v2/abilities/manifests.config";
import { prisma } from "@/utils/prisma";

// The single cross-store grant/extension write service (docs/plans/
// abilities-entitlements.md, rollout step 2). Both the V1 /v2/connections
// handlers AND the V2 conversation-ability PUT write through here, and every
// mutation lands in BOTH stores inside ONE Prisma transaction:
//   - the legacy ConnectionGrant row keeps being written byte-for-byte as
//     before (same upsert/soft-revoke semantics, same wire-visible id), so
//     old replicas still reading it during a rolling deploy — and a rollback,
//     and the pre-readiness legacy matcher — stay correct;
//   - the entitlement tables receive the same fact reshaped (entitlement
//     find-or-create + extension upsert/delete), and every NEW reader (exec's
//     checkEntitlement, the abilities catalog, the V2 endpoints) reads ONLY
//     them.
// The transaction is what keeps the stores from diverging: a failure rolls
// BOTH back, so no path can answer 5xx while one store already authorizes
// (or has stopped authorizing) the other's state.
//
// Revocation retries HEAL unconditionally: the extension delete is never
// gated on the legacy row having transitioned in this attempt, so state left
// divergent by an old replica (or a pre-transaction version) converges on the
// next revoke call rather than surviving it.
//
// Cross-store identity: extension rows share their legacy grant's id (the
// adapter creates them together; the V2 PUT mirror creates the legacy row
// with the extension's id), so ids served by V1 endpoints stay stable and V1
// DELETE-by-id can always address V2-created state. Entitlement ability ids
// are canonical lowercase (normalizeAbilityId); the legacy row's toolkit
// keeps the client's casing (its V1 wire echoes it) and is matched
// case-insensitively.
//
// These functions are the single implementation behind the handlers; tests
// that need V1-shaped state in the new tables seed through them ("the
// V1-adapter path") instead of writing ConnectionGrant rows directly.

export type IssueConnectionGrantInput = {
  /** The owner — from the authenticated JWT, never a body field. */
  accountId: string;
  ownerInboxId: string;
  granteeInboxId: string;
  conversationId: string;
  toolkit: string;
  actions?: string[];
  bundleIds?: string[];
  serviceVersion?: number | null;
  expiresAt?: Date | null;
};

/**
 * Issue (or re-issue) a V1 grant. One grant per (owner, grantee,
 * conversation, toolkit): re-approval updates the same row, refreshing scope
 * and expiry and clearing a prior revocation — exactly the V1 handler
 * semantics. Bundle-id validation stays in the HTTP handler (stale ids can
 * legitimately exist on rows, and exec fails closed on them).
 *
 * On the entitlement side: the extension row is upserted 1:1, and the
 * entitlement is created as `active` when absent (a V1 client only issues
 * grants after connecting; the reconciliation sweep refreshes the status from
 * Composio truth). A revoked entitlement is un-revoked — grant issuance is an
 * explicit user action, the one thing allowed to resurrect a tombstone.
 */
export async function issueConnectionGrant(
  input: IssueConnectionGrantInput,
): Promise<ConnectionGrant> {
  const actions = input.actions ?? [];
  const bundleIds = input.bundleIds ?? [];
  const serviceVersion = input.serviceVersion ?? null;
  const expiresAt = input.expiresAt ?? null;

  return prisma.$transaction(async (tx) => {
    // The legacy row is resolved case-insensitively, not via the composite
    // unique key: legacy toolkits keep the client's casing, so a reissue that
    // spells the toolkit differently must update the SAME semantic grant
    // instead of creating a second one (which would also collide with the
    // shared-id extension). The stored casing stays as first issued; every
    // reader matches it case-insensitively.
    const resolved = await tx.connectionGrant.findFirst({
      where: {
        ownerAccountId: input.accountId,
        granteeInboxId: input.granteeInboxId,
        conversationId: input.conversationId,
        toolkit: { equals: input.toolkit, mode: "insensitive" },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const grant = resolved
      ? await tx.connectionGrant.update({
          where: { id: resolved.id },
          data: {
            ownerInboxId: input.ownerInboxId,
            actions,
            bundleIds,
            serviceVersion,
            expiresAt,
            revokedAt: null,
          },
        })
      : await tx.connectionGrant.create({
          data: {
            ownerAccountId: input.accountId,
            ownerInboxId: input.ownerInboxId,
            granteeInboxId: input.granteeInboxId,
            conversationId: input.conversationId,
            toolkit: input.toolkit,
            actions,
            bundleIds,
            serviceVersion,
            expiresAt,
          },
        });

    const entitlement = await ensureEntitlementForV1Issue(tx, {
      accountId: input.accountId,
      abilityId: normalizeAbilityId(input.toolkit),
    });

    await tx.conversationAbility.upsert({
      where: {
        entitlementId_conversationId_agentInboxId: {
          entitlementId: entitlement.id,
          conversationId: input.conversationId,
          agentInboxId: input.granteeInboxId,
        },
      },
      create: {
        id: grant.id,
        entitlementId: entitlement.id,
        conversationId: input.conversationId,
        agentInboxId: input.granteeInboxId,
        bundleIds,
        actions,
        extendedByInboxId: input.ownerInboxId,
        expiresAt,
        createdAt: grant.createdAt,
      },
      update: {
        bundleIds,
        actions,
        extendedByInboxId: input.ownerInboxId,
        expiresAt,
      },
    });

    return grant;
  });
}

async function ensureEntitlementForV1Issue(
  tx: Prisma.TransactionClient,
  args: { accountId: string; abilityId: string },
) {
  const existing = await tx.abilityEntitlement.findUnique({
    where: {
      accountId_abilityId: {
        accountId: args.accountId,
        abilityId: args.abilityId,
      },
    },
  });
  if (!existing) {
    return tx.abilityEntitlement.create({
      data: {
        accountId: args.accountId,
        abilityId: args.abilityId,
        status: "active",
        abilityVersion: getServedAbilityVersion(args.abilityId),
      },
    });
  }
  if (existing.revokedAt) {
    return tx.abilityEntitlement.update({
      where: { id: existing.id },
      data: { status: "active", revokedAt: null },
    });
  }
  return existing;
}

export type UpsertConversationAbilityInput = {
  /** The extender — from the authenticated JWT, never a body field. */
  accountId: string;
  /** The backing entitlement (already validated active by the handler). */
  entitlementId: string;
  /** Canonical (lowercase) ability id. */
  abilityId: string;
  conversationId: string;
  agentInboxId: string;
  bundleIds: string[];
  extendedByInboxId?: string;
};

/**
 * The V2 extend write (PUT /v2/conversations/.../abilities/...): upserts the
 * ConversationAbility opt-in AND mirrors a legacy ConnectionGrant row in the
 * same transaction, so old replicas' exec (and the pre-readiness legacy
 * matcher) authorize V2-written opt-ins, and V1 GET/DELETE address them by a
 * shared id.
 *
 * The shared identifier is reconciled by the normalized natural key: the
 * legacy rows for (account, agent, conversation, ability) are resolved FIRST
 * — case-insensitively, because legacy toolkits keep the client's casing (a
 * backfilled "GoogleCalendar" grant already shares its id with the extension;
 * an exact-key miss would try to recreate that id and hit the primary key) —
 * and a newly created extension takes the oldest such row's id (a
 * pre-existing legacy-only row, e.g. written by an old replica before the
 * backfill carried it, must not end up paired under two different ids).
 * Without a legacy row, the extension's generated id becomes the pair's id
 * via the mirror create. A later V1 re-issue of the same natural key updates
 * the same pair. When the caller did not provide its inbox id, the mirror's
 * ownerInboxId is empty — V1 responses (which require it) skip such rows,
 * and onBehalfOf selection simply never matches them.
 *
 * A V2 PUT REPLACES the consent scope: `actions` is cleared in both stores.
 * Backfilled extensions carry the legacy grant's raw action slugs, and the
 * check unions actions with bundle-resolved scope — leaving stale slugs
 * behind would let a narrowing PUT (say, down to a read-only bundle) keep
 * authorizing the broader legacy scope.
 */
export async function upsertConversationAbilityExtension(
  input: UpsertConversationAbilityInput,
): Promise<ConversationAbility> {
  return prisma.$transaction(async (tx) => {
    const legacyRows = await tx.connectionGrant.findMany({
      where: {
        ownerAccountId: input.accountId,
        granteeInboxId: input.agentInboxId,
        conversationId: input.conversationId,
        toolkit: { equals: input.abilityId, mode: "insensitive" },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const legacy = legacyRows.length > 0 ? legacyRows[0] : null;
    const existing = await tx.conversationAbility.findUnique({
      where: {
        entitlementId_conversationId_agentInboxId: {
          entitlementId: input.entitlementId,
          conversationId: input.conversationId,
          agentInboxId: input.agentInboxId,
        },
      },
      select: { id: true },
    });

    // Adopt the legacy id only while no extension row holds it yet: an
    // unmerged case-variant entitlement's extension can still carry it
    // mid-window, and a by-id create would hit the primary key.
    let adoptableId: string | null = null;
    if (!existing && legacy) {
      const taken = await tx.conversationAbility.findUnique({
        where: { id: legacy.id },
        select: { id: true },
      });
      adoptableId = taken ? null : legacy.id;
    }
    const extension = existing
      ? await tx.conversationAbility.update({
          where: { id: existing.id },
          data: {
            bundleIds: input.bundleIds,
            actions: [],
            ...(input.extendedByInboxId !== undefined
              ? { extendedByInboxId: input.extendedByInboxId }
              : {}),
          },
        })
      : await tx.conversationAbility.create({
          data: {
            ...(adoptableId ? { id: adoptableId } : {}),
            entitlementId: input.entitlementId,
            conversationId: input.conversationId,
            agentInboxId: input.agentInboxId,
            bundleIds: input.bundleIds,
            extendedByInboxId: input.extendedByInboxId ?? null,
          },
        });

    if (legacyRows.length > 0) {
      // Every case-variant sibling gets the replaced scope too: the legacy
      // matcher (old replicas, pre-readiness fallback) matches toolkit
      // case-insensitively, so a variant left with stale actions would keep
      // authorizing them.
      await tx.connectionGrant.updateMany({
        where: { id: { in: legacyRows.map((row) => row.id) } },
        data: {
          bundleIds: input.bundleIds,
          actions: [],
          revokedAt: null,
          ...(input.extendedByInboxId !== undefined
            ? { ownerInboxId: input.extendedByInboxId }
            : {}),
        },
      });
    } else {
      await tx.connectionGrant.create({
        data: {
          id: extension.id,
          ownerAccountId: input.accountId,
          ownerInboxId: input.extendedByInboxId ?? "",
          granteeInboxId: input.agentInboxId,
          conversationId: input.conversationId,
          toolkit: input.abilityId,
          actions: [],
          bundleIds: input.bundleIds,
        },
      });
    }

    return extension;
  });
}

/**
 * Revoke by natural key (toolkit [+ conversation] [+ grantee]) — the V1
 * grants/revoke semantics. Legacy rows are soft-revoked (revokedAt, audit
 * trail); the matching extensions are deleted (withdrawn opt-ins have no
 * per-extension tombstone — the entitlement row is the audit record). Both
 * happen in one transaction; the extension delete runs regardless of how
 * many legacy rows transitioned, so a retry heals divergent state. Returns
 * the legacy revoked count, which is the wire-visible number.
 */
export async function revokeConnectionGrantsByNaturalKey(args: {
  accountId: string;
  toolkit: string;
  conversationId?: string;
  granteeInboxId?: string;
}): Promise<number> {
  const abilityId = normalizeAbilityId(args.toolkit);
  return prisma.$transaction(async (tx) => {
    const result = await tx.connectionGrant.updateMany({
      where: {
        ownerAccountId: args.accountId,
        toolkit: { equals: args.toolkit, mode: "insensitive" },
        ...(args.conversationId ? { conversationId: args.conversationId } : {}),
        ...(args.granteeInboxId ? { granteeInboxId: args.granteeInboxId } : {}),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    const entitlement = await tx.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId: args.accountId, abilityId },
      },
    });
    if (entitlement) {
      await tx.conversationAbility.deleteMany({
        where: {
          entitlementId: entitlement.id,
          ...(args.conversationId
            ? { conversationId: args.conversationId }
            : {}),
          ...(args.granteeInboxId ? { agentInboxId: args.granteeInboxId } : {}),
        },
      });
    }

    return result.count;
  });
}

/**
 * Revoke one grant by id, scoped to the caller's account — the V1
 * DELETE /grants/:id semantics. Returns the legacy revoked count (0 means
 * not found / not owned / already revoked, indistinguishable on purpose).
 *
 * The write paths keep the pair's ids shared, but revocation must not TRUST
 * that: the id is resolved to its normalized natural key from WHICHEVER
 * store carries it, and both stores are then healed by that natural key in
 * the same transaction — every legacy row (case-insensitively) revoked,
 * every matching extension deleted. A pair whose ids diverged (any
 * historical or mid-window state) therefore still dies whole, whichever id
 * the caller holds; a retry against already-revoked state still clears a
 * surviving counterpart.
 */
export async function revokeConnectionGrantById(args: {
  accountId: string;
  grantId: string;
}): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const legacy = await tx.connectionGrant.findFirst({
      where: { id: args.grantId, ownerAccountId: args.accountId },
      select: { toolkit: true, conversationId: true, granteeInboxId: true },
    });
    const extension = legacy
      ? null
      : await tx.conversationAbility.findFirst({
          where: {
            id: args.grantId,
            entitlement: { is: { accountId: args.accountId } },
          },
          select: {
            conversationId: true,
            agentInboxId: true,
            entitlement: { select: { abilityId: true } },
          },
        });
    if (!legacy && !extension) {
      // Not found or not owned — nothing to reveal, nothing to heal.
      return 0;
    }

    const toolkit = legacy?.toolkit ?? extension?.entitlement.abilityId ?? "";
    const conversationId =
      legacy?.conversationId ?? extension?.conversationId ?? "";
    const agentInboxId =
      legacy?.granteeInboxId ?? extension?.agentInboxId ?? "";

    const result = await tx.connectionGrant.updateMany({
      where: {
        ownerAccountId: args.accountId,
        toolkit: { equals: toolkit, mode: "insensitive" },
        conversationId,
        granteeInboxId: agentInboxId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    const entitlement = await tx.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: {
          accountId: args.accountId,
          abilityId: normalizeAbilityId(toolkit),
        },
      },
      select: { id: true },
    });
    if (entitlement) {
      await tx.conversationAbility.deleteMany({
        where: { entitlementId: entitlement.id, conversationId, agentInboxId },
      });
    }
    // Belt-and-braces for a case-variant entitlement parent the normalized
    // lookup missed mid-sweep: any owned row still carrying the id goes too.
    await tx.conversationAbility.deleteMany({
      where: {
        id: args.grantId,
        entitlement: { is: { accountId: args.accountId } },
      },
    });
    return result.count;
  });
}
