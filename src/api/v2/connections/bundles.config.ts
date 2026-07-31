// Backend-owned service / permission-bundle catalog.
//
// Per the approved iOS plan (convos-ios docs/plans/connections-picker-bundles-draft.md):
// the connections picker shows one card per *bundle* (a human intent like
// "Events"), the device persists only the granted `bundle_id`s, and the backend
// resolves a bundle to its Composio action slugs at execution time. This keeps
// the app free of Composio slugs and lets us re-map actions without an app
// release — bump a service's `version` whenever anything about it changes.
//
// This catalog is the source of truth for two things:
//   1. GET /v2/connections/services — the config the picker fetches.
//   2. exec authorization — granted bundle ids → the set of allowed actions.
//
// Extending it is data work (add services/bundles below + bump `version`); the
// action slugs come from Composio's toolkit action list.

/** A localized string map. MUST always carry an "en" key (the guaranteed fallback). */
export type LocalizedString = { en: string } & Record<string, string>;

export type Bundle = {
  /** Stable id persisted on the grant, e.g. "calendar.events". */
  id: string;
  title: LocalizedString;
  description: LocalizedString;
  defaultEnabled: boolean;
  /** Composio action slugs this bundle grants. The only slug list in the system. */
  composioActions: string[];
  /**
   * A retired bundle: hidden from the public catalog (clients can no longer
   * discover it) but still resolvable at exec time AND still grantable, so
   * (a) existing grants persisting this id keep working and (b) old clients
   * holding a cached catalog (up to its TTL) can still round-trip a grant.
   * Never delete a bundle id that may exist on a grant — deprecate it instead.
   */
  deprecated?: boolean;
};

export type ServiceConfig = {
  /** Equals the Composio toolkit slug. */
  id: string;
  composioSlug: string;
  /** Bumped whenever anything about this service changes (copy, icon, any bundle). */
  version: number;
  displayName: LocalizedString;
  bundles: Bundle[];
};

// Seeded with the plan's reference service. Add more services/bundles here.
export const SERVICE_CONFIGS: ServiceConfig[] = [
  {
    id: "googlecalendar",
    composioSlug: "googlecalendar",
    // v2: added the read-only calendar.events.read bundle (contract: bump on
    // ANY change to the service).
    // v3: corrected the list slug GOOGLECALENDAR_LIST_EVENTS →
    // GOOGLECALENDAR_EVENTS_LIST. Verified against the live Composio v3 tool
    // catalog (2026-06-11): GOOGLECALENDAR_LIST_EVENTS does not exist (404);
    // GOOGLECALENDAR_EVENTS_LIST / _CREATE_EVENT / _UPDATE_EVENT /
    // _DELETE_EVENT are all served.
    // v4: product decision — the picker shows ONE calendar toggle. The public
    // catalog now offers only calendar.events (retitled "View and edit
    // events"); calendar.events.read is deprecated (hidden, still resolvable
    // and grantable — grants in the wild carry it).
    // v5: copy aligned with the Figma design — row title "Events", subtitle
    // "View and edit events on all calendars". Copy-only, but the contract is
    // bump on ANY change (copy included).
    // v6: added GOOGLECALENDAR_PATCH_EVENT to calendar.events — the runtime's
    // update tool moved to patch semantics (chosen over full-replacement
    // UPDATE_EVENT, which stays granted for existing grants/tools). Verified
    // against the live Composio catalog (2026-07-28, full 49-slug list via
    // getRawComposioTools with an explicit limit): PATCH_EVENT is served;
    // independently verified by the runtime lane.
    version: 6,
    displayName: { en: "Google Calendar" },
    bundles: [
      {
        id: "calendar.events",
        title: { en: "Events" },
        description: {
          en: "View and edit events on all calendars",
        },
        defaultEnabled: false,
        composioActions: [
          "GOOGLECALENDAR_EVENTS_LIST",
          "GOOGLECALENDAR_CREATE_EVENT",
          "GOOGLECALENDAR_UPDATE_EVENT",
          "GOOGLECALENDAR_PATCH_EVENT",
          "GOOGLECALENDAR_DELETE_EVENT",
        ],
      },
      {
        // DEPRECATED (v4): folded into the single calendar.events toggle.
        // Kept so existing grants persisting this id still resolve to LIST at
        // exec, and so old clients on a cached v2/v3 catalog can still grant
        // it. Read-only invariant still holds: MUST NOT contain any
        // CREATE/UPDATE/DELETE/PATCH slug.
        id: "calendar.events.read",
        title: { en: "View events" },
        description: { en: "View events on all calendars" },
        defaultEnabled: false,
        composioActions: ["GOOGLECALENDAR_EVENTS_LIST"],
        deprecated: true,
      },
    ],
  },
  {
    id: "gmail",
    composioSlug: "gmail",
    // v1: read-only launch — one mail.read bundle, fetch-only slugs. No
    // send/draft/label/delete slug ships until a write bundle is added
    // deliberately. Slugs verified against the live Composio v3 tool catalog
    // (2026-07-31, full 63-slug list via getRawComposioTools with an explicit
    // limit): GMAIL_FETCH_EMAILS, GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID and
    // GMAIL_FETCH_MESSAGE_BY_THREAD_ID are all served.
    version: 1,
    displayName: { en: "Gmail" },
    bundles: [
      {
        id: "mail.read",
        title: { en: "Emails" },
        description: { en: "Read and search emails in your inbox" },
        defaultEnabled: true,
        composioActions: [
          "GMAIL_FETCH_EMAILS",
          "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
          "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
        ],
      },
    ],
  },
];

const BY_SERVICE = new Map<string, ServiceConfig>(
  SERVICE_CONFIGS.map((s) => [s.id.toLowerCase(), s]),
);

export function getServiceConfig(serviceId: string): ServiceConfig | undefined {
  return BY_SERVICE.get(serviceId.toLowerCase());
}

/**
 * Returns `true` ONLY to assert "this slug is provably not a real action for
 * `serviceId`" — the single signal that makes the exec matcher answer
 * invalid_action instead of no_grant. `true` requires positive evidence: a
 * non-empty catalog was fetched from Composio's LIVE toolkit list (not our
 * consent bundles) and that catalog does not contain the slug. That is the
 * typo'd/guessed-slug case (e.g. "listEvents", the retired
 * "GOOGLECALENDAR_LIST_EVENTS") the agent must fix itself, not re-prompt for.
 *
 * Every other outcome returns `false`. `false` here does NOT mean "valid" — it
 * means "no proof of invalidity, so don't reclassify". The caller treats `false`
 * as "skip the invalid_action backstop and fall through to the grant check"
 * (-> no_grant if ungranted, or allowed if granted). The exact `false` cases:
 *   - unknown toolkit (no service config),
 *   - empty catalog, and
 *   - Composio outage (a throw, which `listToolkitActions` surfaces as an empty
 *     set — same as a genuinely empty fetch).
 * This is the fail-OPEN property: the three lines below can never combine an
 * empty/outage catalog with a `true`, so a real slug is never rejected as
 * invalid_action during a Composio outage (which would wrongly tell the agent to
 * re-prompt for consent — the re-auth loop this PR set out to kill).
 *
 * Sourcing validity from Composio, rather than from the union of our bundles'
 * `composioActions`, is deliberate: a slug Composio really exposes but we simply
 * haven't bundled (e.g. GOOGLECALENDAR_CALENDARS_DELETE) is a real action and a
 * genuine consent gap (no_grant), not invalid — bundle membership is the GRANT
 * layer, not the validity layer. `resolveBundleActions` stays the consent set.
 */
export async function isInvalidAction(
  service: ComposioActionCatalog,
  serviceId: string,
  action: string,
): Promise<boolean> {
  const svc = getServiceConfig(serviceId);
  // Unknown toolkit -> no proof of invalidity -> fall through to no_grant.
  if (!svc) return false;
  const slugs = await service.listToolkitActions(svc.composioSlug);
  // Empty/outage catalog (fail OPEN) -> no proof of invalidity -> fall through
  // to the grant check (no_grant if ungranted). Never invalid_action.
  if (slugs.size === 0) return false;
  // Non-empty catalog that lacks the slug is the ONLY invalid_action signal.
  return !slugs.has(action);
}

/**
 * The full set of valid action slugs Composio's live catalog exposes for
 * `serviceId`, as a sorted array. Backs GET /actions so the agent runtime can
 * fetch the authoritative vocabulary to validate slugs before exec. Returns []
 * for an unknown toolkit or on a catalog miss.
 */
export async function getKnownActions(
  service: ComposioActionCatalog,
  serviceId: string,
): Promise<string[]> {
  const svc = getServiceConfig(serviceId);
  if (!svc) return [];
  const slugs = await service.listToolkitActions(svc.composioSlug);
  return [...slugs].sort();
}

/**
 * The slice of ComposioService that the slug-validity helpers depend on. Keeps
 * bundles.config decoupled from the concrete service (and trivially stubbable in
 * tests) — it only needs the live catalog lookup, nothing else.
 */
export type ComposioActionCatalog = {
  listToolkitActions(toolkit: string): Promise<Set<string>>;
};

// --- Public (client-facing) view of the catalog ------------------------------
//
// The Composio action slugs are the security boundary and stay backend-only:
// clients persist only bundle ids and never resolve actions. The public bundle
// therefore exposes only what the picker needs to render and to round-trip on a
// grant: id (persisted), copy, and the default toggle. Icons are omitted for now
// (kept optional in the contract).

/** A bundle as served to clients — no `composioActions`. */
export type PublicBundle = {
  id: string;
  title: LocalizedString;
  description: LocalizedString;
  defaultEnabled: boolean;
};

/** A service as served to clients — bundles carry no slugs. */
export type PublicServiceConfig = {
  id: string;
  composioSlug: string;
  version: number;
  displayName: LocalizedString;
  bundles: PublicBundle[];
};

/**
 * Strip `composioActions` so no slug ever reaches a client, and drop
 * deprecated bundles: clients only ever see (and offer) the live catalog,
 * while the internal one keeps resolving ids that grants already persist.
 */
export function toPublicServiceConfig(svc: ServiceConfig): PublicServiceConfig {
  return {
    id: svc.id,
    composioSlug: svc.composioSlug,
    version: svc.version,
    displayName: svc.displayName,
    bundles: svc.bundles
      .filter((b) => !b.deprecated)
      .map((b) => ({
        id: b.id,
        title: b.title,
        description: b.description,
        defaultEnabled: b.defaultEnabled,
      })),
  };
}

/** The full public catalog the picker fetches via GET /v2/connections/services. */
export function getPublicServiceConfigs(): PublicServiceConfig[] {
  return SERVICE_CONFIGS.map(toPublicServiceConfig);
}

/**
 * The union of Composio action slugs granted by `bundleIds` on a service.
 * Unknown service or unknown bundle ids contribute nothing (fail-closed): a
 * grant that references only stale/unknown bundles authorizes no actions.
 * Deprecated bundles DO resolve — that is the whole point of deprecating
 * (instead of deleting) a bundle id that grants in the wild still carry.
 */
export function resolveBundleActions(
  serviceId: string,
  bundleIds: string[],
): string[] {
  const svc = getServiceConfig(serviceId);
  if (!svc || bundleIds.length === 0) return [];
  const granted = new Set(bundleIds);
  const actions = new Set<string>();
  for (const bundle of svc.bundles) {
    if (granted.has(bundle.id)) {
      for (const action of bundle.composioActions) actions.add(action);
    }
  }
  return [...actions];
}
