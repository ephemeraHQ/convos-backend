import type { BillingProvider } from "@prisma/client";
import { findTombstoneForKeys } from "@/subscriptions/tombstones";
import { prisma } from "@/utils/prisma";

/**
 * Informative `claimable` signal for the verify 409 (additive contract
 * field): true when POST /v2/accounts/me/subscription/claim may succeed for
 * this caller — the subscription lineage is tombstoned, or live transfer is
 * enabled and the caller is not cooldown-blocked. The claim endpoint always
 * re-evaluates authoritatively; this never grants anything.
 */

/**
 * Whether claims against non-tombstoned (live-owner) subscriptions are
 * enabled. Stays false until the claim endpoint ships its transfer +
 * cooldown evaluation; the claim work flips this alongside the endpoint.
 */
const LIVE_TRANSFER_ENABLED = false;

export const evaluateClaimable = async (args: {
  provider: BillingProvider;
  /** Candidate provider keys (current + rotation predecessor when known). */
  keys: Array<string | null | undefined>;
}): Promise<boolean> => {
  const tombstone = await findTombstoneForKeys(
    prisma,
    args.provider,
    args.keys,
  );
  if (tombstone) return true;
  // Live-owner transfer: enabled state and per-lineage cooldown are evaluated
  // by the claim flow once it ships; report its availability here.
  return LIVE_TRANSFER_ENABLED;
};
