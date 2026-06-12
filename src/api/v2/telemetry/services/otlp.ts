import { z } from "zod";
import {
  TELEMETRY_ALLOWED_POINT_ATTRS,
  TELEMETRY_ALLOWED_RESOURCE_ATTRS,
  TELEMETRY_MAX_POINT_AGE_MS,
  TELEMETRY_METRIC_PREFIXES,
} from "@/config";
import { ValidationError } from "@/utils/errors";

// Loose structural validation. .passthrough() everywhere: we re-serialize
// this body, so unknown OTLP fields must survive.
const attributeSchema = z
  .object({ key: z.string(), value: z.unknown() })
  .passthrough();

const nanoString = z.string().regex(/^\d+$/, "timestamp must be digits");

const dataPointSchema = z
  .object({
    timeUnixNano: nanoString,
    startTimeUnixNano: nanoString.optional(),
    attributes: z.array(attributeSchema).optional(),
  })
  .passthrough();

const dataContainerSchema = z
  .object({ dataPoints: z.array(dataPointSchema).default([]) })
  .passthrough();

const metricSchema = z
  .object({
    name: z.string(),
    sum: dataContainerSchema.optional(),
    histogram: dataContainerSchema.optional(),
    gauge: dataContainerSchema.optional(),
  })
  .passthrough();

const scopeMetricsSchema = z
  .object({
    metrics: z.array(metricSchema).default([]),
    scope: z
      .object({ attributes: z.array(attributeSchema).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const resourceMetricsSchema = z
  .object({
    resource: z
      .object({ attributes: z.array(attributeSchema).default([]) })
      .passthrough()
      .optional(),
    scopeMetrics: z.array(scopeMetricsSchema).default([]),
  })
  .passthrough();

const exportRequestSchema = z
  .object({ resourceMetrics: z.array(resourceMetricsSchema) })
  .passthrough();

type ExportRequest = z.infer<typeof exportRequestSchema>;
type DataPoint = z.infer<typeof dataPointSchema>;

const DATA_KEYS = ["sum", "histogram", "gauge"] as const;

// Metric-level keys allowed to survive re-serialization. Anything else —
// notably containers this sanitizer doesn't walk (summary,
// exponentialHistogram) — is deleted, otherwise it would be forwarded with
// unshifted timestamps and unfiltered attributes via .passthrough().
const METRIC_ALLOWED_KEYS = new Set<string>([
  "name",
  "description",
  "unit",
  "metadata",
  ...DATA_KEYS,
]);

export interface PrepareOptions {
  offsetMs: number; // receivedAt - sentAt (client clock correction)
  receivedAtMs: number;
  serviceName: string;
  environment: string;
}

export interface PreparedBatch {
  body: ExportRequest; // mutated in place, re-serialized by the forwarder
  droppedStalePoints: number;
  strippedAttrKeys: string[]; // resource attrs removed by the allowlist
  strippedPointAttrKeys: string[]; // data point attrs removed by the allowlist
  droppedMetricKeys: string[]; // unknown metric-level keys deleted
  isEmpty: boolean;
}

const shiftNanos = (ts: string, offsetMs: number): string =>
  (BigInt(ts) + BigInt(offsetMs) * 1_000_000n).toString();

export function prepareBatch(
  rawBody: unknown,
  opts: PrepareOptions,
): PreparedBatch {
  const parsed = exportRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid OTLP metrics body: ${parsed.error.issues[0]?.message ?? "parse error"}`,
    );
  }
  const body: ExportRequest = parsed.data;

  // Validate all metric names up front so a rejection throws before any
  // mutation — the function either throws on an untouched object or returns
  // a fully-transformed one.
  for (const rm of body.resourceMetrics) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (!TELEMETRY_METRIC_PREFIXES.some((p) => metric.name.startsWith(p))) {
          throw new ValidationError(`Metric name not allowed: ${metric.name}`);
        }
      }
    }
  }

  const staleCutoffNanos =
    BigInt(opts.receivedAtMs - TELEMETRY_MAX_POINT_AGE_MS) * 1_000_000n;
  // Symmetric upper bound: drop points dated more than 5 min in the future
  // (e.g. from a forged or badly-skewed X-Sent-At producing a large offset).
  const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
  const futureCutoffNanos =
    BigInt(opts.receivedAtMs + FUTURE_TOLERANCE_MS) * 1_000_000n;
  let droppedStalePoints = 0;
  const strippedAttrKeys = new Set<string>();
  const strippedPointAttrKeys = new Set<string>();
  const droppedMetricKeys = new Set<string>();

  for (const rm of body.resourceMetrics) {
    // Resource attribute policy: strip unknown keys, then override
    // service.name and deployment.environment with server-derived values.
    const kept = (rm.resource?.attributes ?? []).filter((a) => {
      if (TELEMETRY_ALLOWED_RESOURCE_ATTRS.has(a.key)) return true;
      strippedAttrKeys.add(a.key);
      return false;
    });
    const overridden = kept.filter(
      (a) => a.key !== "service.name" && a.key !== "deployment.environment",
    );
    overridden.push(
      { key: "service.name", value: { stringValue: opts.serviceName } },
      {
        key: "deployment.environment",
        value: { stringValue: opts.environment },
      },
    );
    rm.resource = { ...(rm.resource ?? {}), attributes: overridden };

    for (const sm of rm.scopeMetrics) {
      // Scope attributes are never forwarded — same trust boundary as
      // resource/point attrs, with no known legitimate use from clients.
      if (sm.scope?.attributes !== undefined) {
        sm.scope.attributes = [];
      }
      // Rebuild each metric from allowlisted keys only, so unwalked
      // containers (summary, exponentialHistogram, future additions) can't
      // smuggle unsanitized points past the DATA_KEYS loop below.
      sm.metrics = sm.metrics.map((metric) => {
        const cleaned: typeof metric = { name: metric.name };
        for (const key of Object.keys(metric)) {
          if (METRIC_ALLOWED_KEYS.has(key)) {
            cleaned[key] = metric[key];
          } else {
            droppedMetricKeys.add(key);
          }
        }
        return cleaned;
      });
      for (const metric of sm.metrics) {
        for (const key of DATA_KEYS) {
          const container = metric[key];
          if (!container) continue;
          const shifted: DataPoint[] = [];
          for (const dp of container.dataPoints) {
            const time = shiftNanos(dp.timeUnixNano, opts.offsetMs);
            const t = BigInt(time);
            if (t < staleCutoffNanos || t > futureCutoffNanos) {
              droppedStalePoints++;
              continue;
            }
            dp.timeUnixNano = time;
            if (dp.startTimeUnixNano !== undefined) {
              dp.startTimeUnixNano = shiftNanos(
                dp.startTimeUnixNano,
                opts.offsetMs,
              );
            }
            // Point attribute policy mirrors the resource one: strip unknown
            // keys (they become Datadog metric tags — PII/cardinality risk).
            if (dp.attributes !== undefined) {
              dp.attributes = dp.attributes.filter((a) => {
                if (TELEMETRY_ALLOWED_POINT_ATTRS.has(a.key)) return true;
                strippedPointAttrKeys.add(a.key);
                return false;
              });
            }
            shifted.push(dp);
          }
          container.dataPoints = shifted;
        }
      }
      // Remove metrics whose every container is now empty.
      sm.metrics = sm.metrics.filter((m) =>
        DATA_KEYS.some((k) => (m[k]?.dataPoints.length ?? 0) > 0),
      );
    }
    rm.scopeMetrics = rm.scopeMetrics.filter((sm) => sm.metrics.length > 0);
  }
  body.resourceMetrics = body.resourceMetrics.filter(
    (rm) => rm.scopeMetrics.length > 0,
  );

  return {
    body,
    droppedStalePoints,
    strippedAttrKeys: [...strippedAttrKeys],
    strippedPointAttrKeys: [...strippedPointAttrKeys],
    droppedMetricKeys: [...droppedMetricKeys],
    isEmpty: body.resourceMetrics.length === 0,
  };
}
