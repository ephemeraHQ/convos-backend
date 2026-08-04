import type { BillingProvider } from "@prisma/client";
import { isTombstoneClaimEnabled } from "@/subscriptions/claim-flags";
import {
  LINEAGE_STATE_TOMBSTONED,
  resolveLineageId,
} from "@/subscriptions/lineage";
import { prisma } from "@/utils/prisma";

/**
 * Informative `claimable` signal for the verify 409 (additive contract
 * field): true when POST /v2/accounts/me/subscription/claim may succeed for
 * this caller. Only Apple tombstone restoration is claimable; live lineage
 * ownership mismatches and Google lineages fail closed.
 */
export const evaluateClaimable = async (args: {
  provider: BillingProvider;
  /** Candidate provider keys (current + rotation predecessor when known). */
  keys: Array<string | null | undefined>;
}): Promise<boolean> => {
  if (args.provider === "googlePlay" || !isTombstoneClaimEnabled())
    return false;
  const lineageId = await resolveLineageId(prisma, args.provider, args.keys);
  if (!lineageId) return false;
  const lineage = await prisma.subscriptionLineage.findUnique({
    where: { id: lineageId },
  });
  if (!lineage) return false;
  return lineage.state === LINEAGE_STATE_TOMBSTONED;
};
