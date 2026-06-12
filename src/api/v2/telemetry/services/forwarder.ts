import { OTLP_METRICS_FORWARD_URL } from "@/config";
import logger from "@/utils/logger";

// POST a prepared OTLP/JSON body to the Datadog Agent's OTLP HTTP receiver.
// Returns false (never throws) on any failure; the handler maps that to 502
// so the client retries with the same Idempotency-Key.
//
// Known limitation (accepted): a timeout after the agent already ingested the
// POST reads as failure, the dedup claim is released, and the retry forwards
// again — at-least-once under ambiguity. The agent is localhost, so an
// accepted-but-timed-out response is rare, and occasional double-counted
// telemetry is cheaper than a durable attempt ledger.
export async function forwardMetrics(
  body: unknown,
  url: string = OTLP_METRICS_FORWARD_URL,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.error(
        { status: res.status, url },
        "telemetry.forward_failed_status",
      );
      return false;
    }
    return true;
  } catch (error) {
    logger.error({ error, url }, "telemetry.forward_failed");
    return false;
  }
}
