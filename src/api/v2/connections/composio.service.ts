import {
  Composio,
  type ConnectedAccountListResponseItem,
} from "@composio/core";
import { COMPOSIO_API_KEY, COMPOSIO_CONNECTION_CALLBACK_URL } from "@/config";
import logger from "@/utils/logger";

// Auth configs rarely change in Composio; cache the toolkit→authConfigId
// resolution in-process so most initiate calls skip the extra round trip.
const AUTH_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

type AuthConfigCacheEntry = { authConfigId: string | null; expiresAt: number };

// Toolkit versions are date-stamped releases (e.g. "20260429_00") published a
// few times a month; an hour of staleness only delays picking up a NEW release,
// it never serves an invalid version.
const TOOLKIT_VERSION_CACHE_TTL_MS = 60 * 60 * 1000;

type ToolkitVersionCacheEntry = { version: string; expiresAt: number };

// A toolkit's action catalog (the set of valid action slugs) changes only when
// Composio publishes a new toolkit release — rarely. Cache the slug set
// per-toolkit so exec's slug-validity check (invalid_action vs no_grant) and
// the /actions endpoint never hit Composio on the hot path. The TTL bounds how
// long a newly-added slug stays unrecognized; an empty set is NOT cached so a
// transient fetch failure cannot stick a toolkit as "no valid slugs".
const TOOLKIT_ACTIONS_CACHE_TTL_MS = 60 * 60 * 1000;

type ToolkitActionsCacheEntry = { slugs: Set<string>; expiresAt: number };

// Safety bound on cursor-following in listForUser. Composio pages default to
// tens of items, so 10 pages comfortably covers any real account; the bound
// exists to keep a broken cursor chain from looping forever.
const LIST_PAGE_LIMIT = 10;

export class ComposioService {
  private composio: Composio;
  private authConfigCache = new Map<string, AuthConfigCacheEntry>();
  private toolkitVersionCache = new Map<string, ToolkitVersionCacheEntry>();
  private toolkitActionsCache = new Map<string, ToolkitActionsCacheEntry>();

  constructor(args: { composio: Composio }) {
    this.composio = args.composio;
  }

  /**
   * Resolve a toolkit slug (e.g. "googlecalendar") to its Composio authConfigId
   * by querying Composio. Picks the first ENABLED auth config for that toolkit.
   * Returns null if no enabled config exists.
   *
   * Clients must send Composio's canonical slug (case-insensitive).
   */
  async resolveAuthConfigId(toolkit: string): Promise<string | null> {
    const now = Date.now();
    const normalized = toolkit.toLowerCase();
    const hit = this.authConfigCache.get(normalized);
    if (hit && hit.expiresAt > now) {
      return hit.authConfigId;
    }

    const list = await this.composio.authConfigs.list({ toolkit: normalized });
    const enabled = list.items.find(
      (item) =>
        item.toolkit.slug.toLowerCase() === normalized &&
        item.status === "ENABLED",
    );
    const authConfigId = enabled?.id ?? null;

    if (!authConfigId) {
      logger.warn(
        {
          toolkit: normalized,
          returnedItems: list.items.map((item) => ({
            id: item.id,
            slug: item.toolkit.slug,
            status: item.status,
            isComposioManaged: item.isComposioManaged,
          })),
          totalPages: list.totalPages,
        },
        "[Composio] resolveAuthConfigId: no ENABLED config matched",
      );
    } else {
      logger.info(
        { toolkit: normalized, authConfigId },
        "[Composio] resolveAuthConfigId: resolved",
      );
    }

    this.authConfigCache.set(normalized, {
      authConfigId,
      expiresAt: now + AUTH_CONFIG_CACHE_TTL_MS,
    });
    return authConfigId;
  }

  /**
   * Resolve the CURRENT published version of a toolkit (e.g. "20260429_00").
   * Composio refuses manual `tools.execute` against the implicit "latest"
   * version (TOOL_VERSION_REQUIRED), so exec pins the newest version at call
   * time instead of hardcoding one that silently ages. Versions are
   * date-stamped (YYYYMMDD_NN), so the lexicographic max is the newest.
   * Returns null when Composio reports no versions — callers fail closed.
   * Misses are NOT cached: a transient gap must not stick for an hour.
   */
  async resolveToolkitVersion(toolkit: string): Promise<string | null> {
    const now = Date.now();
    const normalized = toolkit.toLowerCase();
    const hit = this.toolkitVersionCache.get(normalized);
    if (hit && hit.expiresAt > now) {
      return hit.version;
    }

    const info = await this.composio.toolkits.get(normalized);
    const versions = info.meta.availableVersions ?? [];
    const version = versions.reduce<string | null>(
      (max, candidate) => (max === null || candidate > max ? candidate : max),
      null,
    );

    if (!version) {
      logger.warn(
        { toolkit: normalized },
        "[Composio] resolveToolkitVersion: no available versions",
      );
      return null;
    }

    logger.info(
      { toolkit: normalized, version },
      "[Composio] resolveToolkitVersion: resolved",
    );
    this.toolkitVersionCache.set(normalized, {
      version,
      expiresAt: now + TOOLKIT_VERSION_CACHE_TTL_MS,
    });
    return version;
  }

  /**
   * The set of valid action slugs Composio's LIVE catalog exposes for a toolkit
   * (e.g. "GOOGLECALENDAR_EVENTS_LIST", ...). This is the authoritative
   * vocabulary the exec matcher uses to tell a real-but-ungranted slug
   * (no_grant) from a slug Composio never had (invalid_action) — sourcing it
   * from Composio, not our consent bundles, means a real slug we simply haven't
   * bundled is correctly no_grant, never mislabeled invalid_action.
   *
   * Cached per-toolkit (TTL) so the hot exec path doesn't call Composio every
   * time. Fails OPEN: a Composio THROW (outage) or an empty result is treated as
   * "catalog unavailable" — returns an empty set and is NOT cached. Callers must
   * read an empty set as "unknown", never as "no valid slugs": `isInvalidAction`
   * therefore returns false on an empty set, so the exec matcher falls through to
   * no_grant rather than flagging a real slug invalid_action during an outage
   * (which would wrongly tell the agent to re-prompt for consent). A transient
   * gap must not stick for the TTL either.
   */
  async listToolkitActions(toolkit: string): Promise<Set<string>> {
    const now = Date.now();
    const normalized = toolkit.toLowerCase();
    const hit = this.toolkitActionsCache.get(normalized);
    if (hit && hit.expiresAt > now) {
      return hit.slugs;
    }

    const slugs = new Set<string>();
    try {
      const tools = await this.composio.tools.getRawComposioTools({
        toolkits: [normalized],
      });
      for (const tool of tools) {
        if (tool.slug) slugs.add(tool.slug);
      }
    } catch (error) {
      logger.warn(
        { toolkit: normalized, error },
        "[Composio] listToolkitActions: catalog fetch failed — treating as unavailable",
      );
      return new Set<string>();
    }

    if (slugs.size === 0) {
      logger.warn(
        { toolkit: normalized },
        "[Composio] listToolkitActions: catalog returned no actions (not caching)",
      );
      return slugs;
    }

    logger.info(
      { toolkit: normalized, count: slugs.size },
      "[Composio] listToolkitActions: resolved catalog slugs",
    );
    this.toolkitActionsCache.set(normalized, {
      slugs,
      expiresAt: now + TOOLKIT_ACTIONS_CACHE_TTL_MS,
    });
    return slugs;
  }

  /**
   * Start an OAuth connection flow for a user. Named after our endpoint
   * (POST /connections/initiate); internally this uses the SDK's `link()` —
   * Composio retires `connectedAccounts.initiate()` for Composio-managed
   * OAuth on 2026-07-03 (see https://docs.composio.dev/docs/changelog/2026/04/24).
   * `link()` returns the same ConnectionRequest shape ({ id, status,
   * redirectUrl }), so the endpoint response is unchanged.
   */
  async initiate(args: {
    userId: string;
    authConfigId: string;
    callbackUrl?: string;
  }) {
    return this.composio.connectedAccounts.link(
      args.userId,
      args.authConfigId,
      {
        callbackUrl: args.callbackUrl ?? COMPOSIO_CONNECTION_CALLBACK_URL,
      },
    );
  }

  /**
   * Fetch a connected account only if it belongs to the given userId.
   * Returns null if it doesn't exist or isn't owned by the caller.
   *
   * Composio's retrieve endpoint no longer returns userId on the response,
   * so ownership is verified by listing the caller's accounts. The userId is
   * the caller's stable accountId.
   */
  async getIfOwned(args: { connectionId: string; userId: string }) {
    const { items } = await this.listForUser(args.userId);
    return items.find((item) => item.id === args.connectionId) ?? null;
  }

  /**
   * Every connected account for a user, across all of Composio's result pages
   * (the list endpoint is cursor-paginated). Bounded so a pathological cursor
   * loop cannot hang a request; hitting the bound THROWS instead of returning
   * a partial list, because truncated state must never be served as
   * authoritative (callers treat the throw like any Composio failure — the
   * abilities catalog surfaces entitlementsUnavailable, exec fails closed).
   */
  async listForUser(
    userId: string,
  ): Promise<{ items: ConnectedAccountListResponseItem[] }> {
    const items: ConnectedAccountListResponseItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGE_LIMIT; page++) {
      const list = await this.composio.connectedAccounts.list({
        userIds: [userId],
        ...(cursor ? { cursor } : {}),
      });
      items.push(...list.items);
      if (!list.nextCursor) {
        return { items };
      }
      cursor = list.nextCursor;
    }
    logger.warn(
      { userId, pages: LIST_PAGE_LIMIT, count: items.length },
      "[Composio] listForUser: page bound hit — refusing truncated state",
    );
    throw new Error(
      `Composio connected-account list exceeded ${LIST_PAGE_LIMIT} pages`,
    );
  }

  async delete(connectionId: string) {
    return this.composio.connectedAccounts.delete(connectionId);
  }

  /**
   * Resolve the connectedAccountId for (userId, toolkit) when a grant did not
   * pin one. Picks the first connection matching the toolkit; returns null if
   * the account has no connection for it.
   *
   * The connectedAccountId is a bearer capability — callers keep it server-side
   * and never return it to an agent.
   */
  async resolveConnectionId(args: {
    userId: string;
    toolkit: string;
  }): Promise<string | null> {
    const { items } = await this.listForUser(args.userId);
    const normalized = args.toolkit.toLowerCase();
    const match = items.find(
      (item) => item.toolkit.slug.toLowerCase() === normalized,
    );
    return match?.id ?? null;
  }

  /**
   * Execute a Composio tool action on behalf of an account. The connection is
   * resolved and injected server-side; the agent never holds or names a
   * connectedAccountId. `userId` is the data owner (stable accountId).
   * `version` is the pinned toolkit version (see resolveToolkitVersion) —
   * without it the SDK rejects manual execution (TOOL_VERSION_REQUIRED).
   */
  async execute(args: {
    action: string;
    userId: string;
    arguments: Record<string, unknown>;
    connectedAccountId?: string;
    version?: string;
  }) {
    return this.composio.tools.execute(args.action, {
      userId: args.userId,
      arguments: args.arguments,
      ...(args.connectedAccountId
        ? { connectedAccountId: args.connectedAccountId }
        : {}),
      ...(args.version ? { version: args.version } : {}),
    });
  }
}

let cached: ComposioService | null = null;
let initialized = false;

export function createComposioService(): ComposioService | null {
  if (initialized) {
    return cached;
  }
  initialized = true;

  if (!COMPOSIO_API_KEY) {
    logger.warn("[Composio] COMPOSIO_API_KEY not set, connections disabled");
    return null;
  }

  cached = new ComposioService({
    composio: new Composio({
      apiKey: COMPOSIO_API_KEY,
      allowTracking: false,
    }),
  });
  logger.info("[Composio] Initialised service");
  return cached;
}

// Exposed for tests — resets the singleton.
export function __resetComposioServiceForTests(
  override: ComposioService | null = null,
) {
  cached = override;
  initialized = override !== null;
}
