import { TELEMETRY_BATCH_TTL_MS } from "@/config";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

let _intervalId: ReturnType<typeof setInterval> | null = null;

export async function sweepExpiredBatches(): Promise<number> {
  const cutoff = new Date(Date.now() - TELEMETRY_BATCH_TTL_MS);
  const { count } = await prisma.telemetryBatch.deleteMany({
    where: { receivedAt: { lt: cutoff } },
  });
  if (count > 0) {
    logger.info({ count }, "telemetry.dedup_rows_swept");
  }
  return count;
}

export function startTelemetryTtlSweep(): void {
  if (_intervalId !== null) return;
  _intervalId = setInterval(() => {
    void sweepExpiredBatches().catch((error: unknown) => {
      logger.error({ error }, "telemetry.ttl_sweep_failed");
    });
  }, SWEEP_INTERVAL_MS);
  if (typeof _intervalId === "object" && "unref" in _intervalId) {
    _intervalId.unref();
  }
}

export function stopTelemetryTtlSweep(): void {
  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}
