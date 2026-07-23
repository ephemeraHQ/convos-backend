import type { ConnectionGrant } from "@prisma/client";
import { getServedAbilityVersion } from "@/api/v2/abilities/manifests.config";
import { prisma } from "@/utils/prisma";

// The V1 grant write path as an adapter over the entitlement tables
// (docs/plans/abilities-entitlements.md, rollout step 2).
//
// Every V1 grant mutation lands in BOTH stores:
//   - the legacy ConnectionGrant row keeps being written byte-for-byte as
//     before (same upsert/soft-revoke semantics, same wire-visible id), so
//     old replicas still reading it during a rolling deploy — and a rollback —
//     stay correct;
//   - the entitlement tables receive the same fact reshaped (entitlement
//     find-or-create + extension upsert/delete), and every NEW reader (exec's
//     checkEntitlement, the abilities catalog, the V2 endpoints) reads ONLY
//     them.
//
// The legacy table thus becomes write-only for new replicas; the boot-time
// reconciliation sweep (backfill-entitlements.ts) converges any rows old
// replicas wrote in the meantime. Extensions created here keep the legacy
// grant's id and createdAt, so ids served by V1 endpoints stay stable.
//
// These functions are the single implementation behind the V1 handlers; tests
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

  const grant = await prisma.connectionGrant.upsert({
    where: {
      ownerAccountId_granteeInboxId_conversationId_toolkit: {
        ownerAccountId: input.accountId,
        granteeInboxId: input.granteeInboxId,
        conversationId: input.conversationId,
        toolkit: input.toolkit,
      },
    },
    create: {
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
    update: {
      ownerInboxId: input.ownerInboxId,
      actions,
      bundleIds,
      serviceVersion,
      expiresAt,
      revokedAt: null,
    },
  });

  const entitlement = await ensureEntitlementForV1Issue({
    accountId: input.accountId,
    abilityId: input.toolkit,
  });

  await prisma.conversationAbility.upsert({
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
}

async function ensureEntitlementForV1Issue(args: {
  accountId: string;
  abilityId: string;
}) {
  const existing = await prisma.abilityEntitlement.findUnique({
    where: {
      accountId_abilityId: {
        accountId: args.accountId,
        abilityId: args.abilityId,
      },
    },
  });
  if (!existing) {
    return prisma.abilityEntitlement.create({
      data: {
        accountId: args.accountId,
        abilityId: args.abilityId,
        status: "active",
        abilityVersion: getServedAbilityVersion(args.abilityId),
      },
    });
  }
  if (existing.revokedAt) {
    return prisma.abilityEntitlement.update({
      where: { id: existing.id },
      data: { status: "active", revokedAt: null },
    });
  }
  return existing;
}

/**
 * Revoke by natural key (toolkit [+ conversation] [+ grantee]) — the V1
 * grants/revoke semantics. Legacy rows are soft-revoked (revokedAt, audit
 * trail); the matching extensions are deleted (withdrawn opt-ins have no
 * per-extension tombstone — the entitlement row is the audit record). Returns
 * the legacy revoked count, which is the wire-visible number.
 */
export async function revokeConnectionGrantsByNaturalKey(args: {
  accountId: string;
  toolkit: string;
  conversationId?: string;
  granteeInboxId?: string;
}): Promise<number> {
  const result = await prisma.connectionGrant.updateMany({
    where: {
      ownerAccountId: args.accountId,
      toolkit: args.toolkit,
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      ...(args.granteeInboxId ? { granteeInboxId: args.granteeInboxId } : {}),
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  const entitlement = await prisma.abilityEntitlement.findUnique({
    where: {
      accountId_abilityId: {
        accountId: args.accountId,
        abilityId: args.toolkit,
      },
    },
  });
  if (entitlement) {
    await prisma.conversationAbility.deleteMany({
      where: {
        entitlementId: entitlement.id,
        ...(args.conversationId ? { conversationId: args.conversationId } : {}),
        ...(args.granteeInboxId ? { agentInboxId: args.granteeInboxId } : {}),
      },
    });
  }

  return result.count;
}

/**
 * Revoke one grant by id, scoped to the caller's account — the V1
 * DELETE /grants/:id semantics. Returns the legacy revoked count (0 means
 * not found / not owned / already revoked, indistinguishable on purpose).
 * The extension shares the legacy id (adapter- and backfill-created rows),
 * and the delete is additionally scoped to the caller's entitlements.
 */
export async function revokeConnectionGrantById(args: {
  accountId: string;
  grantId: string;
}): Promise<number> {
  const result = await prisma.connectionGrant.updateMany({
    where: {
      id: args.grantId,
      ownerAccountId: args.accountId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  if (result.count > 0) {
    await prisma.conversationAbility.deleteMany({
      where: {
        id: args.grantId,
        entitlement: { is: { accountId: args.accountId } },
      },
    });
  }
  return result.count;
}
