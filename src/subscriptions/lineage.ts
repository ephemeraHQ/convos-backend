import { BillingProvider, Prisma } from "@prisma/client";
import { fetchSubscriptionPurchaseV2 } from "@/subscriptions/google-play/play-api";
import { isRetryableTxConflict } from "@/utils/deadlock-retry";
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

export const quarantineLineageToken = async (
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

const quarantine = quarantineLineageToken;

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
const INSERT_RESTART_LIMIT = 3;

/** Control-flow signal: lost an alias race, roll back and re-resolve. */
class AliasRaceRestart extends Error {}

/** Control-flow signal: chain resolves to two lineages (never auto-merge). */
class ChainConflict extends Error {
  constructor(public readonly conflictToken: string) {
    super("chain conflict");
  }
}

/**
 * One atomic insert-or-adopt pass over a resolved chain: the lineage row and
 * every alias commit in a single transaction (INSERT ... ON CONFLICT DO
 * NOTHING via createMany/skipDuplicates), then every alias is re-selected.
 * An alias committed by a concurrent resolver against a different lineage
 * rolls the provisional lineage back (AliasRaceRestart) so the caller can
 * restart against the winner's row — a half-created lineage can never leak.
 */
const insertOrAdoptChain = async (chain: string[]): Promise<string> =>
  prisma.$transaction(async (tx) => {
    const provider = BillingProvider.googlePlay;
    const aliasRows = await tx.lineageTokenAlias.findMany({
      where: { token: { in: chain } },
      select: { lineageId: true, token: true },
    });
    const directRows = await tx.subscriptionLineage.findMany({
      where: { provider, lineageKey: { in: chain } },
      select: { id: true },
    });
    const resolved = new Set<string>([
      ...aliasRows.map((a) => a.lineageId),
      ...directRows.map((d) => d.id),
    ]);
    if (resolved.size > 1) {
      throw new ChainConflict(chain[0]);
    }

    let lineageId = [...resolved][0];
    if (!lineageId) {
      // Root = oldest chain member. createMany/skipDuplicates is a true
      // INSERT ... ON CONFLICT DO NOTHING, so a same-key race is adopted by
      // the re-select rather than aborting the transaction.
      const rootKey = chain[chain.length - 1];
      await tx.subscriptionLineage.createMany({
        data: [{ provider, lineageKey: rootKey }],
        skipDuplicates: true,
      });
      const row = await tx.subscriptionLineage.findUnique({
        where: { provider_lineageKey: { provider, lineageKey: rootKey } },
        select: { id: true },
      });
      if (!row) throw new AliasRaceRestart();
      lineageId = row.id;
    }

    // Deterministic insert order (sorted tokens): two competitors inserting
    // overlapping chains acquire the unique-index waits in the same order,
    // so they serialize instead of deadlocking.
    const sortedTokens = [...chain].sort();
    await tx.lineageTokenAlias.createMany({
      data: sortedTokens.map((token) => ({ token, lineageId })),
      skipDuplicates: true,
    });
    // Re-select every alias: any one resolving elsewhere means a concurrent
    // resolver won a member — roll back (including any provisional lineage)
    // and restart against the committed state.
    const committed = await tx.lineageTokenAlias.findMany({
      where: { token: { in: chain } },
      select: { lineageId: true },
    });
    if (
      committed.length !== chain.length ||
      committed.some((a) => a.lineageId !== lineageId)
    ) {
      throw new AliasRaceRestart();
    }
    return lineageId;
  });

/**
 * Google resolve-or-create. Resolves the full token chain first (following
 * `linkedPurchaseToken` recursively with loop detection and a depth bound;
 * a chain member already known to us short-circuits the walk), then commits
 * the lineage row and every alias atomically. Fails closed — quarantine plus
 * a retryable LineageUnresolvedError — on loops, depth overflow, conflicting
 * chains (never auto-merge), and exhausted insert races; it never silently
 * adopts a truncated root.
 */
export const resolveOrCreateGoogleLineage = async (args: {
  token: string;
  linkedPurchaseToken?: string | null;
  /** Kept for call-site compatibility; the chain is always resolved. */
  fetchChain?: boolean;
  fetcher?: GoogleChainFetcher;
}): Promise<string> => {
  const fetcher = args.fetcher ?? defaultChainFetcher;
  const provider = BillingProvider.googlePlay;

  const failClosed = async (
    reason: string,
    message: string,
    payload: Prisma.InputJsonValue,
  ): Promise<never> => {
    await quarantine(provider, args.token, reason, payload);
    throw new LineageUnresolvedError(provider, args.token, message);
  };

  // Collect the chain, newest first. An unfetchable-but-named predecessor
  // still enters the chain (its identity comes from the successor's
  // linkedPurchaseToken), so a later appearance can never mint a second
  // lineage.
  const chain: string[] = [args.token];
  const seen = new Set<string>(chain);
  let next: string | null | undefined = args.linkedPurchaseToken;
  while (next) {
    if (seen.has(next)) {
      return failClosed("chain_loop", "token chain contains a loop", {
        chain,
        loopToken: next,
      });
    }
    if (chain.length >= CHAIN_DEPTH_LIMIT) {
      return failClosed(
        "chain_depth_exceeded",
        "token chain exceeds the depth bound",
        { chain, next },
      );
    }
    chain.push(next);
    seen.add(next);
    // Stop early once a chain member is already known to us — the rest of
    // the chain is already recorded on its lineage.
    const known = await resolveLineageId(prisma, provider, [next]);
    if (known) break;
    const purchase = await fetcher(next);
    next = purchase?.linkedPurchaseToken;
  }

  for (let attempt = 0; attempt < INSERT_RESTART_LIMIT; attempt += 1) {
    try {
      return await insertOrAdoptChain(chain);
    } catch (err) {
      if (err instanceof ChainConflict) {
        return failClosed(
          "alias_conflict_between_lineages",
          "alias conflict between lineages",
          { chain },
        );
      }
      if (err instanceof AliasRaceRestart) {
        continue;
      }
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // Serialization artifact of the same race; restart resolves it.
        continue;
      }
      if (isRetryableTxConflict(err)) {
        continue;
      }
      throw err;
    }
  }
  return failClosed(
    "alias_race_exhausted",
    "alias insert races exhausted the restart budget",
    { chain },
  );
};

/**
 * Ensure a lineage exists for a verify/notification input and return its id.
 * Google inputs resolve their full token chain on every creation path, not
 * only restoration claims.
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
