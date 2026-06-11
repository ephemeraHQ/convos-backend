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
    version: 4,
    displayName: { en: "Google Calendar" },
    bundles: [
      {
        id: "calendar.events",
        title: { en: "View and edit events" },
        description: {
          en: "View, create, update, and delete events on all calendars",
        },
        defaultEnabled: false,
        composioActions: [
          "GOOGLECALENDAR_EVENTS_LIST",
          "GOOGLECALENDAR_CREATE_EVENT",
          "GOOGLECALENDAR_UPDATE_EVENT",
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
];

const BY_SERVICE = new Map<string, ServiceConfig>(
  SERVICE_CONFIGS.map((s) => [s.id.toLowerCase(), s]),
);

export function getServiceConfig(serviceId: string): ServiceConfig | undefined {
  return BY_SERVICE.get(serviceId.toLowerCase());
}

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
