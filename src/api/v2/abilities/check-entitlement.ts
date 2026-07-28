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

/**
 * Exec's per-row applicability rule, extracted so the exec decision and the
 * worker enumerate share one implementation and cannot drift: selector match
 * on the extender's inbox id, the whole-toolkit transition default, the
 * scope-less probe (scoped rows grant SOMETHING; a probe only asks for
 * access), and the action-scope union with its fail-closed treatment of
 * unresolvable bundles. `log` is optional so enumerate's repeated per-action
 * replays do not duplicate exec's per-request diagnostics.
 */
function rowAppliesToAction(
  abilityId: string,
  row: MatchableRow,
  action: string | undefined,
  onBehalfOf: string | undefined,
  log?: Logger,
): boolean {
  if (onBehalfOf !== undefined && row.extendedByInboxId !== onBehalfOf) {
    return false;
  }
  if (row.actions.length === 0 && row.bundleIds.length === 0) {
    log?.warn(
      { extensionId: row.id, abilityId, action },
      "[Abilities] check: extension has no actions/bundleIds — whole-toolkit (transition default)",
    );
    return true;
  }
  if (action === undefined) {
    return true;
  }
  const resolved = resolveBundleActions(abilityId, row.bundleIds);
  if (row.bundleIds.length > 0 && resolved.length === 0) {
    log?.warn(
      { extensionId: row.id, abilityId, bundleIds: row.bundleIds },
      "[Abilities] check: extension bundleIds resolve to no actions (unknown/stale) — fail closed",
    );
  }
  const allowed = new Set<string>([...row.actions, ...resolved]);
  return allowed.has(action);
}

/** The store-independent V1 exec decision tree (see checkForConversation). */
async function decideForConversation(
  args: CheckEntitlementArgs,
  caller: Extract<CheckEntitlementCaller, { kind: "conversation" }>,
  abilityId: string,
  rows: MatchableRow[],
): Promise<CheckEntitlementResult> {
  const { action, onBehalfOf, log } = args;

  const applicable = rows.filter((row) =>
    rowAppliesToAction(abilityId, row, action, onBehalfOf, log),
  );

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

/**
 * One owner of an ability within a conversation, as served by the
 * worker-facing enumerate (GET /v2/abilities/entitlements).
 */
export type ConversationAbilityOwner = {
  /**
   * The member whose connection this entry represents, as that member's
   * conversation-visible inbox id (the extension's extendedByInboxId) — the
   * value exec's onBehalfOf selector matches. Null when a V2 write did not
   * record the extender: no onBehalfOf value can name such an owner, so its
   * entry is advertised only for actions exec resolves to it uniquely
   * without a selector.
   */
  ownerInboxId: string | null;
  /**
   * The resolved allowed-action union for this owner — the same resolution
   * the exec matcher enforces (legacy explicit actions plus bundle-resolved
   * against the current catalog), sorted. Every listed action is executable
   * by exec as-is for this owner (onBehalfOf = ownerInboxId, or no selector
   * when null); actions exec would deny as ambiguous_grant under that call
   * are excluded (see advertisableOwner). Empty means the whole-toolkit
   * transition default (a true legacy grant with neither actions nor
   * bundleIds): every action of the ability is allowed.
   */
  actions: string[];
};

/** One ability usable by the calling agent in the calling conversation. */
export type ConversationEntitlement = {
  abilityId: string;
  /**
   * Owner accounts with at least one cleanly executable action here.
   * Ambiguity is per action, exactly as exec counts it: owners whose scopes
   * overlap under distinct extender inbox ids are all advertised (onBehalfOf
   * isolates each); an action overlapping owners make ambiguous under an
   * entry's own selector is excluded from the affected entries.
   */
  owners: ConversationAbilityOwner[];
};

export type EnumerateConversationEntitlementsResult =
  | { ready: false }
  | { ready: true; abilities: ConversationEntitlement[] };

/**
 * The enumerate companion to checkForConversation: every ability the trusted
 * (conversation, agent) pair may use, per owner, with the same live-extension
 * predicate (expiry) and the same per-row applicability rule the exec matcher
 * applies (rowAppliesToAction — one shared implementation), including its
 * fail-closed treatment of unresolvable bundle scopes and its per-action
 * unique-owner ambiguity rule (see advertisableOwner: an advertised
 * (owner, action) pair is always executable by exec as-is).
 *
 * Unlike the check, this reads the entitlement tables ONLY. Before the
 * migration ledgers confirm the tables converged, rows may still be missing —
 * a partial enumerate would make the agent silently drop abilities — so this
 * answers not-ready and the endpoint fails closed with a retryable 503. Exec
 * keeps its legacy fallback on purpose: it must preserve V1 behavior for an
 * explicitly named action; enumerate has no V1 predecessor to preserve.
 */
export async function enumerateConversationEntitlements(args: {
  caller: { conversationId: string; agentInboxId: string };
  log: Logger;
}): Promise<EnumerateConversationEntitlementsResult> {
  if (!(await isEntitlementReadModelReady())) {
    return { ready: false };
  }

  const now = new Date();
  const extensions = await prisma.conversationAbility.findMany({
    where: {
      conversationId: args.caller.conversationId,
      agentInboxId: args.caller.agentInboxId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: {
      entitlement: { select: { id: true, accountId: true, abilityId: true } },
    },
  });

  // Bucket per ability: ambiguity is decided among one ability's rows. The
  // unique constraints (one entitlement per (account, ability), one extension
  // per (entitlement, conversation, agent)) make each (ability, owner
  // account) single-row, so a row IS an owner candidate.
  const rowsByAbility = new Map<string, MatchableRow[]>();
  for (const row of extensions) {
    const abilityId = row.entitlement.abilityId;
    const bucket = rowsByAbility.get(abilityId) ?? [];
    bucket.push({
      id: row.id,
      actions: row.actions,
      bundleIds: row.bundleIds,
      extendedByInboxId: row.extendedByInboxId,
      ownerAccountId: row.entitlement.accountId,
      entitlementId: row.entitlement.id,
    });
    rowsByAbility.set(abilityId, bucket);
  }

  const abilities: ConversationEntitlement[] = [];
  for (const [abilityId, rows] of [...rowsByAbility.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const owners: ConversationAbilityOwner[] = [];
    for (const row of rows) {
      const owner = advertisableOwner(abilityId, row, rows, args.log);
      if (owner) owners.push(owner);
    }
    if (owners.length > 0) {
      abilities.push({
        abilityId,
        owners: owners.sort((a, b) =>
          (a.ownerInboxId ?? "").localeCompare(b.ownerInboxId ?? ""),
        ),
      });
    }
  }

  return { ready: true, abilities };
}

/**
 * The advertisement rule: an owner entry is served only with the actions the
 * runtime can actually execute for that owner, decided by replaying exec's
 * own applicability + unique-owner rule (rowAppliesToAction) for the exact
 * call the runtime would make — onBehalfOf = the entry's ownerInboxId, or no
 * selector at all when the extender was never recorded (null), since no
 * onBehalfOf value can name such an owner.
 *
 * Where overlapping grants would make exec answer ambiguous_grant for that
 * call — two owner accounts behind the same extender inbox id, or a
 * null-extender owner overlapping any other owner — the action is dropped
 * from the affected entry, and an entry left with nothing is withheld: fail
 * closed, enumerate must never advertise an (owner, action) pair exec would
 * deny. Owners whose scopes overlap under distinct selectors are all
 * advertised in full: onBehalfOf isolates each.
 *
 * A whole-toolkit row (the legacy transition default) advertises as an empty
 * actions array meaning "everything", which cannot express "everything
 * except the overlap" — so a whole-toolkit entry is withheld entirely when
 * any co-selectable rival grants anything at all. Fail closed again: exec
 * would still allow the non-overlapping remainder, and stays the authority
 * if the runtime tries it anyway.
 */
function advertisableOwner(
  abilityId: string,
  row: MatchableRow,
  siblingRows: MatchableRow[],
  log: Logger,
): ConversationAbilityOwner | null {
  const selector = row.extendedByInboxId ?? undefined;
  const wholeToolkit = row.actions.length === 0 && row.bundleIds.length === 0;
  const scope = resolvedActions(abilityId, row);

  if (!wholeToolkit && scope.length === 0) {
    log.warn(
      { extensionId: row.id, abilityId, bundleIds: row.bundleIds },
      "[Abilities] enumerate: extension scope resolves to no actions (unknown/stale bundles) — not advertised",
    );
    return null;
  }

  // The rows exec could co-select with this one on the call described above.
  const rivals = siblingRows.filter(
    (sibling) =>
      sibling.ownerAccountId !== row.ownerAccountId &&
      rowAppliesToAction(abilityId, sibling, undefined, selector),
  );

  if (wholeToolkit) {
    const overlapped = rivals.some(
      (rival) =>
        (rival.actions.length === 0 && rival.bundleIds.length === 0) ||
        resolvedActions(abilityId, rival).length > 0,
    );
    if (overlapped) {
      log.warn(
        { extensionId: row.id, abilityId },
        "[Abilities] enumerate: whole-toolkit entry overlaps another owner's grant — withheld (fail closed)",
      );
      return null;
    }
    return { ownerInboxId: row.extendedByInboxId, actions: [] };
  }

  const executable = scope.filter((action) =>
    rivals.every(
      (rival) => !rowAppliesToAction(abilityId, rival, action, selector),
    ),
  );
  if (executable.length === 0) {
    log.warn(
      { extensionId: row.id, abilityId },
      "[Abilities] enumerate: every action is ambiguous under this owner's selector — not advertised",
    );
    return null;
  }
  return { ownerInboxId: row.extendedByInboxId, actions: executable };
}
