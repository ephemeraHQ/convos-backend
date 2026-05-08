import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

const NONCE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export async function sweepNonces(): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "AuthNonce" WHERE "createdAt" < now() - interval '1 hour'
  `;
}

export function startNonceSweep() {
  const handle = setInterval(() => {
    sweepNonces().catch((err: unknown) => {
      logger.warn({ err }, "AuthNonce sweep failed");
    });
  }, NONCE_SWEEP_INTERVAL_MS);
  handle.unref();
  return handle;
}
