import type { BillingProvider } from "@prisma/client";
import {
  isGoogleClaimEnabled,
  isLiveTransferEnabled,
  SUBSCRIPTION_CLAIM_COOLDOWN_DAYS,
} from "@/subscriptions/claim-flags";
import {
  LINEAGE_STATE_TOMBSTONED,
  resolveLineageId,
} from "@/subscriptions/lineage";
import { prisma } from "@/utils/prisma";

/**
 * Informative `claimable` signal for the verify 409 (additive contract
 * field): true when POST /v2/accounts/me/subscription/claim may succeed for
 * this caller — the lineage is tombstoned (restoration tier), or live
 * transfer is enabled and the caller is not cooldown/freeze-blocked. The
 * claim endpoint always re-evaluates authoritatively; this never grants
 * anything.
 */
export const evaluateClaimable = async (args: {
  provider: BillingProvider;
  /** Candidate provider keys (current + rotation predecessor when known). */
  keys: Array<string | null | undefined>;
}): Promise<boolean> => {
  // Provider scope: Google claims ship disabled (Apple-only product today).
  if (args.provider === "googlePlay" && !isGoogleClaimEnabled()) {
    return false;
  }
  const lineageId = await resolveLineageId(prisma, args.provider, args.keys);
  if (!lineageId) return false;
  const lineage = await prisma.subscriptionLineage.findUnique({
    where: { id: lineageId },
  });
  if (!lineage) return false;
  if (lineage.state === LINEAGE_STATE_TOMBSTONED) return true;
  if (!isLiveTransferEnabled()) return false;
  if (lineage.liveTransferFrozenAt) return false;
  if (lineage.lastTransferAt) {
    const cooldownMs = SUBSCRIPTION_CLAIM_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() - lineage.lastTransferAt.getTime() < cooldownMs) {
      return false;
    }
  }
  return true;
};
