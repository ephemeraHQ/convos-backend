import type {
  BillingProvider,
  Prisma,
  SubscriptionLineage,
} from "@prisma/client";
import {
  LINEAGE_STATE_TOMBSTONED,
  LineageUnresolvedError,
  quarantineLineageToken,
  resolveLineageId,
  resolveOrCreateGoogleLineage,
} from "@/subscriptions/lineage";
import type { prisma } from "@/utils/prisma";

type DbClient = Prisma.TransactionClient | typeof prisma;

/**
 * Tombstone semantics over lineage state. A deleted owner's lineage carries
 * state "tombstoned": webhooks ack events on it as counted no-ops, verify
 * grants no entitlement (409 with an eligibility-derived claimable signal),
 * and Play token rotation is absorbed into the lineage's alias set rather
 * than escaping it. A live Subscription row for the key always wins (the
 * claim flow restores the lineage to "live" when it re-homes the
 * subscription).
 */

/**
 * Thrown by upsertFromVerify when the presented provider key (or its
 * rotation predecessor) resolves to a tombstoned lineage and no live
 * Subscription row exists. The handler maps it to the same 409 envelope as an
 * ownership mismatch and evaluates whether restoration is currently enabled.
 */
export class SubscriptionTombstonedError extends Error {
  constructor(
    public readonly provider: BillingProvider,
    /** The lineage's canonical key. */
    public readonly matchedKey: string,
    /** The key the caller presented (differs from matchedKey on rotation). */
    public readonly presentedKey: string,
    public readonly accountRef: string,
    public readonly lineageId: string,
  ) {
    super("Subscription belongs to a deleted account");
    this.name = "SubscriptionTombstonedError";
    Object.setPrototypeOf(this, SubscriptionTombstonedError.prototype);
  }
}

/** The tombstoned lineage matching any candidate key/alias, if one exists. */
export const findTombstonedLineage = async (
  db: DbClient,
  provider: BillingProvider,
  keys: Array<string | null | undefined>,
): Promise<SubscriptionLineage | null> => {
  const lineageId = await resolveLineageId(db, provider, keys);
  if (!lineageId) return null;
  const lineage = await db.subscriptionLineage.findUnique({
    where: { id: lineageId },
  });
  if (!lineage || lineage.state !== LINEAGE_STATE_TOMBSTONED) return null;
  return lineage;
};

/**
 * Absorb a rotated token into the lineage's alias set so future lookups by
 * the new token resolve without chain-walking. Routed through the atomic
 * conflict-detecting lineage resolver — never a bare alias upsert: a token
 * that already belongs to ANOTHER lineage is a genuine two-lineage conflict
 * that must quarantine (the resolver writes the LineageQuarantine row), not
 * silently no-op and let the event mutate the wrong lineage.
 *
 * Returns "absorbed" when the token verifiably resolves to the expected
 * lineage, "conflict" when it does not (already quarantined; the caller
 * must not apply any funding/invalidation effect for the event).
 */
export const absorbTombstoneRotation = async (args: {
  token: string;
  linkedPurchaseToken?: string | null;
  lineageId: string;
}): Promise<"absorbed" | "conflict"> => {
  try {
    const resolved = await resolveOrCreateGoogleLineage({
      token: args.token,
      linkedPurchaseToken: args.linkedPurchaseToken,
    });
    if (resolved === args.lineageId) return "absorbed";
    // Consistent chain, but it resolves to a different lineage than the
    // tombstone lookup matched: ambiguous attribution — quarantine.
    await quarantineLineageToken(
      "googlePlay",
      args.token,
      "tombstone_rotation_mismatch",
      { expectedLineageId: args.lineageId, resolvedLineageId: resolved },
    );
    return "conflict";
  } catch (err) {
    if (err instanceof LineageUnresolvedError) {
      // The resolver already quarantined (alias conflict, loop, depth).
      return "conflict";
    }
    throw err;
  }
};
