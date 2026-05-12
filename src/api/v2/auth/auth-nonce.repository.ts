import { randomBytes } from "crypto";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

const NONCE_BYTES = 32;

// Best-effort inline purge of stale AuthNonce rows. Runs on every issue.
// Reason: avoid a background sweep job whose failures we'd miss. Table is
// bounded tiny (rate-limited issuance + 5-minute consume TTL + 1-hour purge),
// so the DELETE is sub-millisecond and safe to run on the hot path.
// Failure here must never prevent a nonce from being issued.
async function sweepStaleNonces(): Promise<void> {
  try {
    await prisma.$executeRaw`
      DELETE FROM "AuthNonce" WHERE "createdAt" < now() - interval '1 hour'
    `;
  } catch (err) {
    logger.warn({ err }, "AuthNonce inline sweep failed");
  }
}

export async function issueNonce(): Promise<string> {
  await sweepStaleNonces();
  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  await prisma.authNonce.create({ data: { nonce } });
  return nonce;
}

/**
 * Atomic single-use consume.
 * Returns true iff the nonce existed AND was younger than the 5-minute window
 * (hardcoded in the SQL below). Concurrent consumers race; only one wins.
 */
export async function consumeNonce(nonce: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ nonce: string }>>`
    DELETE FROM "AuthNonce"
    WHERE nonce = ${nonce}
      AND "createdAt" > now() - interval '5 minutes'
    RETURNING nonce
  `;
  return rows.length === 1;
}
