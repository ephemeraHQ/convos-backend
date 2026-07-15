import { BillingProvider, Prisma } from "@prisma/client";
import { fetchSubscriptionPurchaseV2 } from "@/subscriptions/google-play/play-api";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Subscription lineage resolution and locking.
 *
 * A lineage is one purchase line: Apple originalTransactionId, or a Google
 * linkedPurchaseToken chain resolved to its root with every rotated token
 * recorded as an alias. The lineage row is the canonical first lock (rule 1
 * of the lock order, see src/subscriptions/AGENTS.md) for verify, claim,
 * webhooks, and the deletion teardown, the cooldown anchor, and the
 * tombstone carrier.
 *
 * Creation follows resolve-or-create: a small retryable insert step outside
 * the money transaction, which then begins by taking the lineage FOR UPDATE
 * lock. Google chains that cannot be resolved consistently (alias conflicts
 * between lineages) are never auto-merged: they land in LineageQuarantine
 * and the caller gets LineageUnresolvedError (retryable).
 */

export const LINEAGE_STATE_LIVE = "live";
export const LINEAGE_STATE_TOMBSTONED = "tombstoned";

/**
 * Proof that the caller holds the lineage FOR UPDATE lock for the duration
 * of `tx`. Custody operations and lineage-scoped grants require this value —
 * a type-level enforcement of lock-order rule 1.
 */
export type LineageLockContext = {
  readonly lineageId: string;
  readonly __brand: "LineageLockContext";
};

export class LineageUnresolvedError extends Error {
  constructor(
    public readonly provider: BillingProvider,
    public readonly token: string,
    public readonly reason: string,
  ) {
    super(`Subscription lineage unresolved: ${reason}`);
    this.name = "LineageUnresolvedError";
    Object.setPrototypeOf(this, LineageUnresolvedError.prototype);
  }
}

type DbClient = Prisma.TransactionClient | typeof prisma;

/**
 * Take the lineage row lock. Must be the transaction's first locking
 * statement on every path that touches lineage-scoped money state.
 */
export const lockLineage = async (
  tx: Prisma.TransactionClient,
  lineageId: string,
): Promise<LineageLockContext> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "SubscriptionLineage" WHERE id = ${lineageId}::uuid FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new LineageUnresolvedError(
      BillingProvider.apple,
      lineageId,
      "lineage row disappeared",
    );
  }
  return { lineageId } as LineageLockContext;
};

/** Resolve an existing lineage id by provider key or Google alias. */
export const resolveLineageId = async (
  db: DbClient,
  provider: BillingProvider,
  keys: Array<string | null | undefined>,
): Promise<string | null> => {
  const candidates = keys.filter((k): k is string => !!k);
  if (candidates.length === 0) return null;
  const direct = await db.subscriptionLineage.findFirst({
    where: { provider, lineageKey: { in: candidates } },
    select: { id: true },
  });
  if (direct) return direct.id;
  if (provider === BillingProvider.googlePlay) {
    const alias = await db.lineageTokenAlias.findFirst({
      where: { token: { in: candidates } },
      select: { lineageId: true },
    });
    if (alias) return alias.lineageId;
  }
  return null;
};

const quarantine = async (
  provider: BillingProvider,
  token: string,
  reason: string,
  payload?: Prisma.InputJsonValue,
): Promise<void> => {
  await prisma.lineageQuarantine.create({
    data: { provider, token, reason, payload },
  });
  logger.error({ provider, token, reason }, "subscription.lineage.quarantined");
};

/**
 * Insert-or-adopt a lineage row. Prisma's upsert is select-then-insert under
 * concurrency, so the loser of a same-key race lands on P2002 — re-resolve
 * and adopt the winner's row.
 */
const upsertLineageRow = async (
  provider: BillingProvider,
  lineageKey: string,
): Promise<string> => {
  try {
    const created = await prisma.subscriptionLineage.upsert({
      where: { provider_lineageKey: { provider, lineageKey } },
      update: {},
      create: { provider, lineageKey },
    });
    return created.id;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const winner = await prisma.subscriptionLineage.findUnique({
        where: { provider_lineageKey: { provider, lineageKey } },
        select: { id: true },
      });
      if (winner) return winner.id;
    }
    throw err;
  }
};

/** Apple: trivial resolve-or-create keyed on the stable OTX. */
export const resolveOrCreateAppleLineage = async (
  originalTransactionId: string,
): Promise<string> => {
  const existing = await resolveLineageId(prisma, BillingProvider.apple, [
    originalTransactionId,
  ]);
  if (existing) return existing;
  return upsertLineageRow(BillingProvider.apple, originalTransactionId);
};

export type GoogleChainFetcher = (
  token: string,
) => Promise<{ linkedPurchaseToken?: string | null } | null>;

const defaultChainFetcher: GoogleChainFetcher = async (token) => {
  try {
    return await fetchSubscriptionPurchaseV2(token);
  } catch {
    // Unfetchable predecessor: identity still known from the successor's
    // linkedPurchaseToken; caller records it as an alias without fetching.
    return null;
  }
};

const CHAIN_DEPTH_LIMIT = 10;

/**
 * Google resolve-or-create. Resolves the token chain (recursively when
 * `fetchChain` is set — the claim path; verify/webhooks pass the pair they
 * already hold), records every member as an alias, and creates the lineage
 * rooted at the oldest known member when none exists. Conflicting chains
 * (members resolving to two different lineages) quarantine and throw.
 */
export const resolveOrCreateGoogleLineage = async (args: {
  token: string;
  linkedPurchaseToken?: string | null;
  fetchChain?: boolean;
  fetcher?: GoogleChainFetcher;
}): Promise<string> => {
  const fetcher = args.fetcher ?? defaultChainFetcher;

  // Collect the chain, newest first.
  const chain: string[] = [args.token];
  const seen = new Set<string>(chain);
  let next: string | null | undefined = args.linkedPurchaseToken;
  let depth = 0;
  while (next && !seen.has(next) && depth < CHAIN_DEPTH_LIMIT) {
    chain.push(next);
    seen.add(next);
    depth += 1;
    if (!args.fetchChain) break;
    // Stop early once a chain member is already known to us.
    const known = await resolveLineageId(prisma, BillingProvider.googlePlay, [
      next,
    ]);
    if (known) break;
    const purchase = await fetcher(next);
    next = purchase?.linkedPurchaseToken;
  }

  // Any member already resolving to a lineage? Conflicts quarantine.
  const lineageIds = new Set<string>();
  for (const member of chain) {
    const id = await resolveLineageId(prisma, BillingProvider.googlePlay, [
      member,
    ]);
    if (id) lineageIds.add(id);
  }
  if (lineageIds.size > 1) {
    await quarantine(
      BillingProvider.googlePlay,
      args.token,
      "alias_conflict_between_lineages",
      { chain },
    );
    throw new LineageUnresolvedError(
      BillingProvider.googlePlay,
      args.token,
      "alias conflict between lineages",
    );
  }

  let lineageId: string;
  const known = [...lineageIds][0];
  if (known) {
    lineageId = known;
  } else {
    // Root = oldest chain member. Insert with conflict-adopt: if a
    // concurrent resolver won, adopt its row.
    lineageId = await upsertLineageRow(
      BillingProvider.googlePlay,
      chain[chain.length - 1],
    );
  }

  // Record every chain member as an alias of the lineage. An alias that
  // already points elsewhere is a genuine inconsistency -> quarantine.
  for (const member of chain) {
    const existing = await prisma.lineageTokenAlias.findUnique({
      where: { token: member },
    });
    if (existing && existing.lineageId !== lineageId) {
      await quarantine(
        BillingProvider.googlePlay,
        member,
        "alias_points_at_other_lineage",
        { chain, lineageId },
      );
      throw new LineageUnresolvedError(
        BillingProvider.googlePlay,
        member,
        "alias points at another lineage",
      );
    }
    if (!existing) {
      try {
        await prisma.lineageTokenAlias.upsert({
          where: { token: member },
          update: {},
          create: { token: member, lineageId },
        });
      } catch (err) {
        if (
          !(
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
          )
        ) {
          throw err;
        }
        // Lost the alias race; verify the winner points at our lineage.
        const winner = await prisma.lineageTokenAlias.findUnique({
          where: { token: member },
        });
        if (winner && winner.lineageId !== lineageId) {
          await quarantine(
            BillingProvider.googlePlay,
            member,
            "alias_points_at_other_lineage",
            { chain, lineageId },
          );
          throw new LineageUnresolvedError(
            BillingProvider.googlePlay,
            member,
            "alias points at another lineage",
          );
        }
      }
    }
  }

  return lineageId;
};

/**
 * Ensure a lineage exists for a verify/notification input and return its id.
 */
export const resolveOrCreateLineageForKeys = async (args: {
  provider: BillingProvider;
  /** Apple OTX, or the current Google purchase token. */
  key: string;
  linkedPurchaseToken?: string | null;
}): Promise<string> => {
  if (args.provider === BillingProvider.apple) {
    return resolveOrCreateAppleLineage(args.key);
  }
  return resolveOrCreateGoogleLineage({
    token: args.key,
    linkedPurchaseToken: args.linkedPurchaseToken,
  });
};
