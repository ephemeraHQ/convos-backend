import type { Logger } from "pino";
import { normalizeAbilityId } from "@/api/v2/abilities/ability-id";
import { ABILITY_MANIFESTS } from "@/api/v2/abilities/manifests.config";
import { isEntitlementReadModelReady } from "@/api/v2/abilities/read-readiness";
import {
  getServiceConfig,
  isInvalidAction,
  resolveBundleActions,
  type ComposioActionCatalog,
} from "@/api/v2/connections/bundles.config";
import { prisma } from "@/utils/prisma";

// The entitlement enforcement function (docs/plans/abilities-entitlements.md,
// "Check"). Internal service, not an endpoint: POST /v2/composio/exec is the
// day-one consumer; the MCP gateway exposes it as an RPC later.
//
// Two caller shapes, because of what each surface can PROVE:
//   - conversation: the trusted (conversationId, agentInboxId) pair the
//     assistants worker stamps as headers on the exec path. No caller can
//     prove an initiating account there, so the check resolves candidate
//     owner accounts from the pair and uses the optional onBehalfOf selector
//     (an owner inbox id) to pick between members who extended the same
//     ability — denying ambiguous_grant when it cannot.
//   - account: a proven account id (the future MCP-gateway path after PKI
//     validation; no consumer today).
//
// The conversation path reads the entitlement tables ONLY once the migration
// ledgers confirm they are complete (see read-readiness.ts); until then it
// runs the same matcher over the legacy ConnectionGrant rows, so a replica
// booted mid-rollout never denies existing grants. Both paths share one
// decision function — the store they read differs, the semantics cannot.
//
// The denial vocabulary is the frozen cross-team contract: exec's existing
// codes verbatim (no_grant, ambiguous_grant, invalid_action), plus the
// additive lifecycle codes (needs_reauth, unknown_ability) which only the
// account path emits — the conversation path must not change observable exec
// behavior, and V1 exec never gated on credential lifecycle at authorize time
// (a dead credential surfaces downstream as connection_not_found / a Composio
// error, exactly as before).

export type CheckEntitlementCaller =
  | { kind: "conversation"; conversationId: string; agentInboxId: string }
  | { kind: "account"; accountId: string };

export type CheckEntitlementDenialCode =
  | "no_grant"
  | "ambiguous_grant"
  | "invalid_action"
  | "needs_reauth"
  | "unknown_ability";

export type CheckEntitlementResult =
  | {
      allowed: true;
      /** Whose credential to act with (the entitlement's account). */
      ownerAccountId: string;
      /** Null only on the legacy-fallback path (no entitlement row yet). */
      entitlementId: string | null;
      /**
       * The resolved allowed action slugs (legacy explicit actions plus the
       * bundle-resolved set against the CURRENT catalog). Empty means the
       * whole-toolkit transition default (a true legacy grant with neither
       * actions nor bundleIds).
       */
      actions: string[];
    }
  | { allowed: false; code: CheckEntitlementDenialCode };

export type CheckEntitlementArgs = {
  caller: CheckEntitlementCaller;
  /** The ability (Composio toolkit slug for Composio-backed abilities). */
  abilityId: string;
  /** The action slug being invoked; omit for a pure "any access?" probe. */
  action?: string;
  /** Owner selector for group conversations (an owner inbox id). */
  onBehalfOf?: string;
  /**
   * Live action-slug catalog backing the invalid_action backstop (fail-open:
   * without it — or on an empty/outage catalog — a denial stays no_grant,
   * never invalid_action). Pass the ComposioService; null skips the backstop.
   */
  catalog: ComposioActionCatalog | null;
  log: Logger;
};

export async function checkEntitlement(
  args: CheckEntitlementArgs,
): Promise<CheckEntitlementResult> {
  if (args.caller.kind === "conversation") {
    return checkForConversation(args, args.caller);
  }
  return checkForAccount(args, args.caller);
}

/**
 * One extension-shaped row, whichever store it came from: a
 * ConversationAbility (new tables) or a live ConnectionGrant reshaped
 * (legacy fallback). The matcher below sees only this shape.
 */
type MatchableRow = {
  id: string;
  actions: string[];
  bundleIds: string[];
  extendedByInboxId: string | null;
  ownerAccountId: string;
  entitlementId: string | null;
};

/**
 * The exec-parity path. Semantics are a verbatim port of the V1 exec grant
 * matcher: live-extension predicate (expiry), case-normalized ability match,
 * onBehalfOf filtering on the extender's inbox id, the action-scope union
 * (legacy actions + bundle-resolved, whole-toolkit only when both are empty),
 * invalid_action-before-no_grant when nothing applies, and ambiguous_grant
 * when more than one owner remains. Entitlement lifecycle status is
 * deliberately NOT consulted here (see the module comment).
 *
 * Which store it reads is gated by the migration ledgers: ConversationAbility
 * once the backfill has confirmed convergence, the legacy ConnectionGrant
 * rows before that (a replica must never authorize from tables still being
 * populated). Both feed the same decision function.
 */
async function checkForConversation(
  args: CheckEntitlementArgs,
  caller: Extract<CheckEntitlementCaller, { kind: "conversation" }>,
): Promise<CheckEntitlementResult> {
  const abilityId = normalizeAbilityId(args.abilityId);
  const now = new Date();

  let rows: MatchableRow[];
  if (await isEntitlementReadModelReady()) {
    const extensions = await prisma.conversationAbility.findMany({
      where: {
        conversationId: caller.conversationId,
        agentInboxId: caller.agentInboxId,
        // Stored ability ids are canonical lowercase (writes normalize; the
        // reconciliation sweep merged historical case variants before this
        // read path was declared ready).
        entitlement: { is: { abilityId } },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      include: {
        entitlement: { select: { id: true, accountId: true } },
      },
    });
    rows = extensions.map(
      (row): MatchableRow => ({
        id: row.id,
        actions: row.actions,
        bundleIds: row.bundleIds,
        extendedByInboxId: row.extendedByInboxId,
        ownerAccountId: row.entitlement.accountId,
        entitlementId: row.entitlement.id,
      }),
    );
  } else {
    // Legacy fallback: the same live predicate over ConnectionGrant, which
    // the adapters keep dual-writing for exactly this window. Toolkit
    // casing in legacy rows is as-sent, so the match is case-insensitive.
    const grants = await prisma.connectionGrant.findMany({
      where: {
        conversationId: caller.conversationId,
        granteeInboxId: caller.agentInboxId,
        toolkit: { equals: abilityId, mode: "insensitive" },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    rows = grants.map(
      (grant): MatchableRow => ({
        id: grant.id,
        actions: grant.actions,
        bundleIds: grant.bundleIds,
        extendedByInboxId: grant.ownerInboxId,
        ownerAccountId: grant.ownerAccountId,
        entitlementId: null,
      }),
    );
  }

  return decideForConversation(args, caller, abilityId, rows);
}

/** The store-independent V1 exec decision tree (see checkForConversation). */
async function decideForConversation(
  args: CheckEntitlementArgs,
  caller: Extract<CheckEntitlementCaller, { kind: "conversation" }>,
  abilityId: string,
  rows: MatchableRow[],
): Promise<CheckEntitlementResult> {
  const { action, onBehalfOf, log } = args;

  const applicable = rows.filter((row) => {
    if (onBehalfOf !== undefined && row.extendedByInboxId !== onBehalfOf) {
      return false;
    }
    if (row.actions.length === 0 && row.bundleIds.length === 0) {
      log.warn(
        { extensionId: row.id, abilityId, action },
        "[Abilities] check: extension has no actions/bundleIds — whole-toolkit (transition default)",
      );
      return true;
    }
    if (action === undefined) {
      // Scoped rows grant SOMETHING; a scope-less probe only asks for access.
      return true;
    }
    const resolved = resolveBundleActions(abilityId, row.bundleIds);
    if (row.bundleIds.length > 0 && resolved.length === 0) {
      log.warn(
        { extensionId: row.id, abilityId, bundleIds: row.bundleIds },
        "[Abilities] check: extension bundleIds resolve to no actions (unknown/stale) — fail closed",
      );
    }
    const allowed = new Set<string>([...row.actions, ...resolved]);
    return allowed.has(action);
  });

  if (applicable.length === 0) {
    // Backstop (authoritative): distinguish a bad slug from a real consent
    // gap, exactly as V1 exec did — see bundles.config.ts isInvalidAction for
    // the fail-open contract. Unknown abilities fall through to no_grant
    // (legacy whole-toolkit grants are keyed by toolkit, not catalog
    // membership).
    if (action !== undefined && args.catalog !== null) {
      const svc = getServiceConfig(abilityId);
      if (svc && (await isInvalidAction(args.catalog, abilityId, action))) {
        log.warn(
          { agentInboxId: caller.agentInboxId, abilityId, action },
          "[Abilities] check: action not in toolkit catalog — invalid_action (not a consent gap)",
        );
        return { allowed: false, code: "invalid_action" };
      }
    }
    log.warn(
      { agentInboxId: caller.agentInboxId, abilityId, action, onBehalfOf },
      "[Abilities] check: no matching extension",
    );
    return { allowed: false, code: "no_grant" };
  }

  const owners = new Set(applicable.map((row) => row.ownerAccountId));
  if (owners.size > 1) {
    log.warn(
      { conversationId: caller.conversationId, abilityId, owners: owners.size },
      "[Abilities] check: ambiguous — onBehalfOf required",
    );
    return { allowed: false, code: "ambiguous_grant" };
  }

  const chosen = applicable[0];
  return {
    allowed: true,
    ownerAccountId: chosen.ownerAccountId,
    entitlementId: chosen.entitlementId,
    actions: resolvedActions(abilityId, chosen),
  };
}

/**
 * The proven-account path (future MCP gateway; no consumer today). Account
 * scope has no extension row, so the allowed set is the entitlement's whole
 * ability: every action its live bundles resolve to. Lifecycle DOES gate
 * here — that is the point of the additive codes.
 */
async function checkForAccount(
  args: CheckEntitlementArgs,
  caller: Extract<CheckEntitlementCaller, { kind: "account" }>,
): Promise<CheckEntitlementResult> {
  const { action, log } = args;
  const abilityId = normalizeAbilityId(args.abilityId);

  if (!ABILITY_MANIFESTS.some((m) => m.id === abilityId)) {
    return { allowed: false, code: "unknown_ability" };
  }

  const entitlement = await prisma.abilityEntitlement.findUnique({
    where: {
      accountId_abilityId: { accountId: caller.accountId, abilityId },
    },
  });
  if (!entitlement || entitlement.revokedAt) {
    return { allowed: false, code: "no_grant" };
  }
  if (entitlement.status !== "active") {
    return { allowed: false, code: "needs_reauth" };
  }

  const svc = getServiceConfig(abilityId);
  const allowed = new Set<string>();
  for (const bundle of svc?.bundles ?? []) {
    for (const slug of bundle.composioActions) allowed.add(slug);
  }
  if (action !== undefined && !allowed.has(action)) {
    if (args.catalog !== null && svc) {
      if (await isInvalidAction(args.catalog, abilityId, action)) {
        return { allowed: false, code: "invalid_action" };
      }
    }
    log.warn(
      { accountId: caller.accountId, abilityId, action },
      "[Abilities] check: action outside the ability's bundles — no_grant",
    );
    return { allowed: false, code: "no_grant" };
  }

  return {
    allowed: true,
    ownerAccountId: caller.accountId,
    entitlementId: entitlement.id,
    actions: [...allowed].sort(),
  };
}

function resolvedActions(
  abilityId: string,
  row: { actions: string[]; bundleIds: string[] },
): string[] {
  if (row.actions.length === 0 && row.bundleIds.length === 0) return [];
  return [
    ...new Set<string>([
      ...row.actions,
      ...resolveBundleActions(abilityId, row.bundleIds),
    ]),
  ].sort();
}
