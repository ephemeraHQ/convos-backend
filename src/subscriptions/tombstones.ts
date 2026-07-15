import type {
  BillingProvider,
  Prisma,
  SubscriptionTombstone,
} from "@prisma/client";
import type { prisma } from "@/utils/prisma";

type DbClient = Prisma.TransactionClient | typeof prisma;

/**
 * Provider-key billing tombstones. Written by the account-deletion teardown
 * (one row per provider identity the deleted account's subscriptions carried),
 * consulted by subscription verify and the store webhooks so a deleted
 * account's still-active store subscription can neither error nor resurrect
 * account-linked rows:
 *
 * - verify on a tombstoned key (no live row) -> 409 subscription_account_mismatch
 *   with claimable: true, no row created, no entitlement;
 * - webhooks on a tombstoned key -> acknowledged, counted no-op;
 * - Play token rotation onto a tombstoned token -> the rotated token is added
 *   to the tombstone set rather than escaping it.
 *
 * A live Subscription row for the same key always wins over a tombstone
 * (the subscription-claim flow re-homes a tombstoned key into a new account
 * by creating a fresh row; the tombstone stays as history).
 */

/**
 * Thrown by upsertFromVerify when the presented provider key (or its rotation
 * predecessor) is tombstoned and no live Subscription row exists. The handler
 * maps it to the same 409 envelope as an ownership mismatch, with
 * claimable: true.
 */
export class SubscriptionTombstonedError extends Error {
  constructor(
    public readonly provider: BillingProvider,
    /** The tombstoned key that matched (may be the rotation predecessor). */
    public readonly matchedKey: string,
    /** The key the caller presented (differs from matchedKey on rotation). */
    public readonly presentedKey: string,
    public readonly accountRef: string,
  ) {
    super("Subscription belongs to a deleted account");
    this.name = "SubscriptionTombstonedError";
    Object.setPrototypeOf(this, SubscriptionTombstonedError.prototype);
  }
}

/** First tombstone matching any of the candidate provider keys. */
export const findTombstoneForKeys = async (
  db: DbClient,
  provider: BillingProvider,
  keys: Array<string | null | undefined>,
): Promise<SubscriptionTombstone | null> => {
  const candidates = keys.filter((k): k is string => !!k);
  if (candidates.length === 0) return null;
  return db.subscriptionTombstone.findFirst({
    where: { provider, providerKey: { in: candidates } },
  });
};

/**
 * Absorb a token rotation onto an existing tombstone: give the newly seen
 * key its own row so future lookups by that key stay tombstoned without
 * chain-walking. Idempotent.
 */
export const absorbTombstoneRotation = async (
  db: DbClient,
  args: { provider: BillingProvider; newKey: string; accountRef: string },
): Promise<void> => {
  await db.subscriptionTombstone.upsert({
    where: {
      provider_providerKey: {
        provider: args.provider,
        providerKey: args.newKey,
      },
    },
    update: {},
    create: {
      provider: args.provider,
      providerKey: args.newKey,
      accountRef: args.accountRef,
    },
  });
};
