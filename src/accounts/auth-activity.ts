import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Record "any authenticated act" on the account. The live-transfer contest
 * window uses lastAuthAt strictly as a veto — an old owner who touches any
 * authenticated route during the window cancels the pending transfer — so
 * the stamp must be reliable exactly when it matters:
 *
 * - The write is AWAITED before the request proceeds (a fire-and-forget
 *   stamp could land after settlement locked and read the row).
 * - The timestamp is database now(), the same clock that stamps the pending
 *   row's createdAt, so app/DB clock skew can never make a later act
 *   compare as older.
 * - Throttling applies ONLY while the account has no pending outgoing
 *   transfer. With one pending, every authenticated act is stamped
 *   unconditionally — a suppressed write inside the throttle window would
 *   otherwise leave lastAuthAt before the pending row and the transfer
 *   would settle despite real victim activity.
 *
 * A stamp failure is logged and does not fail the request (the fence read
 * already succeeded; settlement's locked read plus the null-as-veto rule
 * remain the fail-safe).
 */
const STAMP_INTERVAL_MS = 5 * 60 * 1000;

export const stampAuthActivity = async (
  accountId: string,
  knownLastAuthAt: Date | null,
): Promise<void> => {
  try {
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
  } catch (err) {
    logger.warn({ err, accountId }, "auth.activity_stamp_failed");
  }
};
