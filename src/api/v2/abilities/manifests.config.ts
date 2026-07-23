// Backend-owned ability catalog (Connections V2).
//
// An ability is one integration (Google Calendar, Spotify, ...) described by a
// manifest: identity, copy, auth kind, and the permission bundles it offers.
// This is the enumeration layer of the entitlements model (see
// docs/plans/abilities-entitlements.md): GET /v2/abilities serves this catalog
// merged with the caller's entitlement state, and clients render it with no
// local knowledge of any service.
//
// Composio-backed abilities reference the service/bundle catalog in
// bundles.config.ts rather than duplicating it: bundles stay the single
// user-facing permission unit and action-slug resolution stays where it is.
// The version a client sees for an ability is composite — manifest version
// plus the linked service's version (0 when none) — so bundle or copy changes
// made in bundles.config.ts bump the served ability version without anyone
// having to remember to touch the manifest. The wire catalogVersion is
// computed from the served versions (see getCatalogVersion), so it moves with
// them and with launches.
// Adding an ability is data work: add a manifest below (plus, for
// Composio-backed ones, a service entry in bundles.config.ts).
//
// MCP tool schemas and action-queue schemas (`tools[]` / `actions[]` in the
// plan) join the manifest when the gateway needs them; they are never served
// to clients.

import {
  getServiceConfig,
  toPublicServiceConfig,
  type LocalizedString,
  type PublicBundle,
} from "@/api/v2/connections/bundles.config";
import logger from "@/utils/logger";

/**
 * The manually-bumped base for the served catalog version: bump it for
 * catalog-level changes no per-ability version captures (e.g. removing an
 * ability). The wire `catalogVersion` is computed — see getCatalogVersion.
 */
export const CATALOG_VERSION = 1;

export type AbilityAuthType = "oauth" | "none";

export type AbilityManifest = {
  /** Stable ability id. For Composio-backed abilities equals the toolkit slug. */
  id: string;
  /**
   * Bumped whenever anything about this manifest changes (copy included).
   * Clients see manifest version + linked service version (see
   * getPublicAbilities), so service-side bundle changes bump the served
   * version on their own.
   */
  version: number;
  displayName: LocalizedString;
  subtitle: LocalizedString;
  auth: { type: AbilityAuthType };
  /**
   * Per-platform icon URLs. Optional until the asset/upload story lands (open
   * question in the plan); clients fall back to a local placeholder.
   */
  icon?: { iosUrl: string; androidUrl: string };
  /**
   * Registered but not yet launched: excluded from the served catalog.
   * Clearing this flag (once the ability's auth path works) is the launch
   * switch — no client release involved.
   */
  hidden?: boolean;
};

// The first-round abilities are all registered up front so each launch is a
// flag flip. Only googlecalendar is live: it is the one ability with a
// working auth path and a service entry in bundles.config.ts.
export const ABILITY_MANIFESTS: AbilityManifest[] = [
  {
    id: "googlecalendar",
    version: 1,
    displayName: { en: "Google Calendar" },
    subtitle: { en: "View and edit events" },
    auth: { type: "oauth" },
  },
  {
    id: "coinbase",
    version: 1,
    displayName: { en: "Coinbase" },
    subtitle: { en: "Check prices and balances" },
    auth: { type: "oauth" },
    hidden: true,
  },
  {
    id: "shopify",
    version: 1,
    displayName: { en: "Shopify" },
    subtitle: { en: "Manage your shop" },
    auth: { type: "oauth" },
    hidden: true,
  },
  {
    id: "spotify",
    version: 1,
    displayName: { en: "Spotify" },
    subtitle: { en: "Playlists, artists, and concerts" },
    auth: { type: "oauth" },
    hidden: true,
  },
  {
    id: "youtube",
    version: 1,
    displayName: { en: "YouTube" },
    subtitle: { en: "Search and share videos" },
    auth: { type: "oauth" },
    hidden: true,
  },
  {
    id: "gmail",
    version: 1,
    displayName: { en: "Gmail" },
    subtitle: { en: "Read and send email" },
    auth: { type: "oauth" },
    hidden: true,
  },
];

/** An ability as served to clients — bundles carry no Composio slugs. */
export type PublicAbility = {
  id: string;
  version: number;
  displayName: LocalizedString;
  subtitle: LocalizedString;
  auth: { type: AbilityAuthType };
  icon?: { iosUrl: string; androidUrl: string };
  bundles: PublicBundle[];
};

/**
 * Servable = visible AND usable. An OAuth ability whose service entry is
 * missing (or resolves to zero public bundles) can begin an OAuth flow but
 * can never be extended through the non-empty-bundle contract — serving it
 * would strand users mid-flow. Such a manifest is treated as still hidden
 * (warn once) until its bundles.config.ts entry lands; unhiding it is not
 * enough to launch it. Auth-less abilities have no bundle requirement.
 */
function isServable(m: AbilityManifest): boolean {
  if (m.hidden) return false;
  if (m.auth.type !== "oauth") return true;
  const svc = getServiceConfig(m.id);
  if (svc && toPublicServiceConfig(svc).bundles.length > 0) return true;
  warnOnceMissingService(m.id);
  return false;
}

/**
 * The served catalog: hidden manifests dropped, and visible OAuth manifests
 * without a usable service entry dropped too (see isServable). Bundles come
 * from the service catalog; the served version is manifest version + service
 * version (0 when none), so any change to either side bumps it.
 */
export function getPublicAbilities(): PublicAbility[] {
  return ABILITY_MANIFESTS.filter(isServable).map((m) => {
    const svc = getServiceConfig(m.id);
    return {
      id: m.id,
      version: m.version + (svc?.version ?? 0),
      displayName: m.displayName,
      subtitle: m.subtitle,
      auth: m.auth,
      ...(m.icon ? { icon: m.icon } : {}),
      bundles: svc ? toPublicServiceConfig(svc).bundles : [],
    };
  });
}

/**
 * The composite version an ability is (or would be) served with: manifest
 * version + linked service version. Resolves hidden manifests too — the
 * entitlement tables record the version an account bound against even for a
 * registered-but-unlaunched ability. 0 when the ability has no manifest at
 * all (e.g. a legacy toolkit outside the catalog).
 */
export function getServedAbilityVersion(abilityId: string): number {
  const manifest = ABILITY_MANIFESTS.find(
    (m) => m.id === abilityId.toLowerCase(),
  );
  if (!manifest) return 0;
  return manifest.version + (getServiceConfig(manifest.id)?.version ?? 0);
}

/**
 * The served catalog version: the manual base plus the sum of served ability
 * versions. Computed so it bumps on its own whenever an ability's composite
 * version moves (manifest edits, service-side bundle/copy changes) and
 * whenever an ability launches (unhiding adds its version to the sum).
 */
export function getCatalogVersion(): number {
  return ABILITY_MANIFESTS.filter(isServable).reduce(
    (sum: number, m: AbilityManifest): number =>
      sum + m.version + (getServiceConfig(m.id)?.version ?? 0),
    CATALOG_VERSION,
  );
}

// A missing/bundle-less service entry is static configuration, not a
// transient condition; one warning per process per ability is signal enough
// without flooding the log on every catalog request.
const warnedMissingServiceIds = new Set<string>();

function warnOnceMissingService(abilityId: string) {
  if (warnedMissingServiceIds.has(abilityId)) return;
  warnedMissingServiceIds.add(abilityId);
  logger.warn(
    { abilityId },
    "[Abilities] Visible OAuth ability has no usable service entry (no bundles) — excluded from the served catalog",
  );
}
