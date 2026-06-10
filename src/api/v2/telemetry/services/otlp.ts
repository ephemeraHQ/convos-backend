import { z } from "zod";
import {
  TELEMETRY_ALLOWED_RESOURCE_ATTRS,
  TELEMETRY_MAX_POINT_AGE_MS,
  TELEMETRY_METRIC_PREFIXES,
} from "@/config";

export class TelemetryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryValidationError";
  }
}

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
  .object({ metrics: z.array(metricSchema).default([]) })
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

export interface PrepareOptions {
  offsetMs: number; // receivedAt - sentAt (client clock correction)
  receivedAtMs: number;
  serviceName: string;
  environment: string;
}

export interface PreparedBatch {
  body: ExportRequest; // mutated in place, re-serialized by the forwarder
  droppedStalePoints: number;
  strippedAttrKeys: string[];
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
    throw new TelemetryValidationError(
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
          throw new TelemetryValidationError(
            `Metric name not allowed: ${metric.name}`,
          );
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
    isEmpty: body.resourceMetrics.length === 0,
  };
}
