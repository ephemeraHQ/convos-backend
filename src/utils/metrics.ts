import { metrics } from "@opentelemetry/api";

// Counters resolve against the global MeterProvider registered by
// instrumentation.ts. When that file hasn't run (tests, scripts), the API
// falls back to a no-op meter, so calling these is always safe.
const meter = metrics.getMeter("convos-backend");

const telemetryBatchesReceived = meter.createCounter(
  "convos_backend.telemetry.batches_received",
  {
    description:
      "Telemetry bundles received on POST /api/v2/telemetry/metrics, by client and outcome",
    unit: "{batch}",
  },
);

export type TelemetryBatchOutcome =
  | "accepted"
  | "duplicate"
  | "rejected"
  | "forward_failed";

// One call per request, at its terminal point — the counter's sum across
// outcomes equals total requests handled.
export function countTelemetryBatch(
  client: string,
  outcome: TelemetryBatchOutcome,
) {
  telemetryBatchesReceived.add(1, { client, outcome });
}
