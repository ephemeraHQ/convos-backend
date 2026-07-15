import { prisma } from "@/utils/prisma";

/**
 * Record "any authenticated act" on the account. The live-transfer contest
 * window uses lastAuthAt strictly as a veto - an old owner who touches any
 * authenticated route during the window cancels the pending transfer - so
 * the stamp must be reliable exactly when it matters:
 *
 * - The write is awaited before the request proceeds (a fire-and-forget
 *   stamp could land after settlement locked and read the row).
 * - The timestamp is database now(), the same clock that stamps the pending
 *   row's createdAt, so app/DB clock skew can never make a later act
 *   compare as older.
 * - Throttling applies only while the account has no pending outgoing
 *   transfer. With one pending, every authenticated act is stamped
 *   unconditionally - a suppressed write inside the throttle window would
 *   otherwise leave lastAuthAt before the pending row and the transfer
 *   would settle despite real victim activity.
 * - Failures propagate (fail closed): a failed stamp must never silently
 *   cost a veto. Callers fail the request with a 5xx so the client retries;
 *   the alternative - swallowing the error and proceeding - lets a
 *   transient DB blip during a contest window hand the subscription to the
 *   claimant despite real owner activity. An UPDATE matching zero rows
 *   (account deleted mid-request) is not a failure: there is no veto left
 *   to preserve.
 */
const STAMP_INTERVAL_MS = 5 * 60 * 1000;

export const stampAuthActivity = async (
  accountId: string,
  knownLastAuthAt: Date | null,
): Promise<void> => {
  const withinThrottle =
    knownLastAuthAt !== null &&
    Date.now() - knownLastAuthAt.getTime() < STAMP_INTERVAL_MS;
  if (withinThrottle) {
    const pending = await prisma.subscriptionTransfer.findFirst({
      where: { status: "pending", fromAccountId: accountId },
      select: { id: true },
    });
    if (!pending) return;
  }
  await prisma.$executeRaw`
    UPDATE "Account" SET "lastAuthAt" = now() WHERE id = ${accountId}::uuid
  `;
};
