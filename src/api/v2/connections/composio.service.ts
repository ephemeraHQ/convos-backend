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

export class ComposioService {
  private composio: Composio;
  private authConfigCache = new Map<string, AuthConfigCacheEntry>();

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

  async initiate(args: {
    userId: string;
    authConfigId: string;
    callbackUrl?: string;
  }) {
    return this.composio.connectedAccounts.initiate(
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
    const list = await this.composio.connectedAccounts.list({
      userIds: [args.userId],
    });
    const items: ConnectedAccountListResponseItem[] = list.items;
    return items.find((item) => item.id === args.connectionId) ?? null;
  }

  async listForUser(userId: string) {
    return this.composio.connectedAccounts.list({ userIds: [userId] });
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
    const list = await this.composio.connectedAccounts.list({
      userIds: [args.userId],
    });
    const normalized = args.toolkit.toLowerCase();
    const items: ConnectedAccountListResponseItem[] = list.items;
    const match = items.find(
      (item) => item.toolkit.slug.toLowerCase() === normalized,
    );
    return match?.id ?? null;
  }

  /**
   * Execute a Composio tool action on behalf of an account. The connection is
   * resolved and injected server-side; the agent never holds or names a
   * connectedAccountId. `userId` is the data owner (stable accountId).
   */
  async execute(args: {
    action: string;
    userId: string;
    arguments: Record<string, unknown>;
    connectedAccountId?: string;
  }) {
    return this.composio.tools.execute(args.action, {
      userId: args.userId,
      arguments: args.arguments,
      ...(args.connectedAccountId
        ? { connectedAccountId: args.connectedAccountId }
        : {}),
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
