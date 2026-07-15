import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Record "any authenticated act" on the account. The live-transfer contest
 * window uses lastAuthAt strictly as a veto — an old owner who touches any
 * authenticated route during the window cancels the pending transfer — so
 * the stamp must cover every authenticated request, not only token mints.
 *
 * Fire-and-forget and throttled: at most one write per account per interval
 * (the guard is repeated in the WHERE clause so concurrent requests do not
 * stack writes). A failure never fails the request.
 */
const STAMP_INTERVAL_MS = 5 * 60 * 1000;

export const stampAuthActivity = (
  accountId: string,
  knownLastAuthAt: Date | null,
): void => {
  const threshold = new Date(Date.now() - STAMP_INTERVAL_MS);
  if (knownLastAuthAt && knownLastAuthAt.getTime() > threshold.getTime()) {
    return;
  }
  void prisma.account
    .updateMany({
      where: {
        id: accountId,
        OR: [{ lastAuthAt: null }, { lastAuthAt: { lt: threshold } }],
      },
      data: { lastAuthAt: new Date() },
    })
    .catch((err: unknown) => {
      logger.warn({ err, accountId }, "auth.activity_stamp_failed");
    });
};
