import type {
  BillingProvider,
  Prisma,
  SubscriptionLineage,
} from "@prisma/client";
import {
  LINEAGE_STATE_TOMBSTONED,
  resolveLineageId,
} from "@/subscriptions/lineage";
import type { prisma } from "@/utils/prisma";

type DbClient = Prisma.TransactionClient | typeof prisma;

/**
 * Tombstone semantics over lineage state. A deleted owner's lineage carries
 * state "tombstoned": webhooks ack events on it as counted no-ops, verify
 * grants no entitlement (409 with an eligibility-derived claimable signal),
 * and a restoration claim flips the lineage back to "live" when it recreates
 * the subscription.
 */

/**
 * Thrown by upsertFromVerify when the presented provider key (or its
 * rotation predecessor) resolves to a tombstoned lineage and no live
 * Subscription row exists. The handler maps it to the same 409 envelope as an
 * ownership mismatch and evaluates whether restoration is currently enabled.
 */
export class SubscriptionTombstonedError extends Error {
  constructor(
    /** The lineage's canonical key. */
    public readonly matchedKey: string,
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
