import { OTLP_TRACES_FORWARD_URL } from "@/config";
import logger from "@/utils/logger";

// Outcome of a forward attempt. `permanent` distinguishes a payload the agent
// rejected (4xx) — which retrying can never fix — from a transient failure
// (5xx / network). The handler maps a permanent failure to 4xx so the client
// DROPS the batch instead of wedging its queue head retrying a poison payload,
// and a transient failure to 502 so the client retries.
export interface ForwardResult {
  ok: boolean;
  permanent: boolean;
}

// Only a 4xx that means "the payload itself is unacceptable" is permanent —
// retrying identical bytes can never fix it, so the client should drop the
// batch rather than wedge its FIFO queue head. Everything else in the 4xx range
// (401/403/404 auth or wrong-URL misconfig, 408/429 timeout/throttle, etc.) is
// a TRANSIENT server-side condition: an op fix or a retry resolves it, so we
// must NOT tell the client to drop valid batches. Default-transient,
// explicit-permanent is safer than an ever-growing retryable exclusion list.
const PERMANENT_4XX = new Set([
  400, // Bad Request — malformed body
  413, // Payload Too Large
  415, // Unsupported Media Type
  422, // Unprocessable Entity — semantically invalid body
]);

// POST a sanitized OTLP/JSON traces body to the Datadog Agent's OTLP HTTP
// receiver. Never throws. Only the payload-fatal 4xx codes in PERMANENT_4XX are
// permanent; every other 4xx, plus any 5xx or network error, is transient.
export async function forwardTraces(
  body: unknown,
  url: string = OTLP_TRACES_FORWARD_URL,
): Promise<ForwardResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      // Reject on any redirect rather than following it — a 3xx would turn this
      // POST into a GET on the target and a 200 there would look like success
      // even though the batch was never ingested. fetch throws on redirect, so
      // it lands in the catch below as a transient failure (the client retries).
      redirect: "error",
    });
    if (!res.ok) {
      // Permanent only for payload-fatal 4xx (the agent rejected the bytes);
      // all other failures are transient so the client retries instead of
      // dropping a batch over a server-side misconfig or hiccup.
      const permanent = PERMANENT_4XX.has(res.status);
      logger.error(
        { status: res.status, url, permanent },
        "telemetry.traces_forward_failed_status",
      );
      return { ok: false, permanent };
    }
    return { ok: true, permanent: false };
  } catch (error) {
    // Network/timeout failure — transient, the client should retry.
    logger.error({ error, url }, "telemetry.traces_forward_failed");
    return { ok: false, permanent: false };
  }
}
