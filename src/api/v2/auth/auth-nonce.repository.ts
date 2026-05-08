import { randomBytes } from "crypto";
import { prisma } from "@/utils/prisma";

const NONCE_BYTES = 32;

export async function issueNonce(): Promise<string> {
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
