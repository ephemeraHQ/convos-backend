import { describe, expect, test } from "vitest";
import { prepareBatch } from "@/api/v2/telemetry/services/otlp";
import { ValidationError } from "@/utils/errors";

// Local view of the OTLP shape these tests assert against. The production
// PreparedBatch.body is strongly typed; tests cast to this concrete view to
// navigate fields the test knows are present (e.g. sum vs histogram).
type TestMetric = {
  name: string;
  unit?: string;
  sum?: { dataPoints: { timeUnixNano: string; startTimeUnixNano?: string }[] };
  histogram?: {
    dataPoints: {
      timeUnixNano: string;
      startTimeUnixNano?: string;
      bucketCounts: string[];
    }[];
  };
};
type TestBody = {
  resourceMetrics: {
    schemaUrl?: string;
    resource: {
      attributes: { key: string; value: { stringValue: string } }[];
    };
    scopeMetrics: { metrics: TestMetric[] }[];
  }[];
};

const NOW_MS = 1_750_000_000_000; // fixed "receivedAt" for determinism
const ms = (n: number) => BigInt(n) * 1_000_000n;

function makeBody(opts?: {
  metricName?: string;
  timeMs?: number;
  resourceAttrs?: { key: string; value: { stringValue: string } }[];
}) {
  const timeMs = opts?.timeMs ?? NOW_MS - 60_000; // 1 min old by default
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: opts?.resourceAttrs ?? [
            { key: "service.name", value: { stringValue: "spoofed" } },
            { key: "os.version", value: { stringValue: "14" } },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: "convos-meters" },
            metrics: [
              {
                name: opts?.metricName ?? "api.auth_retry",
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      startTimeUnixNano: ms(timeMs - 1000).toString(),
                      timeUnixNano: ms(timeMs).toString(),
                      asInt: "3",
                      attributes: [],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

const baseOpts = {
  offsetMs: 0,
  receivedAtMs: NOW_MS,
  serviceName: "convos-android",
  environment: "convos-otr-dev",
};

describe("prepareBatch", () => {
  test("valid batch passes through with overridden resource attrs", () => {
    const out = prepareBatch(makeBody(), baseOpts);
    expect(out.isEmpty).toBe(false);
    expect(out.droppedStalePoints).toBe(0);
    const body = out.body as unknown as TestBody;
    const attrs = body.resourceMetrics[0].resource.attributes;
    const get = (k: string) =>
      attrs.find((a) => a.key === k)?.value.stringValue;
    expect(get("service.name")).toBe("convos-android"); // spoof overridden
    expect(get("deployment.environment")).toBe("convos-otr-dev");
    expect(get("os.version")).toBe("14"); // allowed attr kept
  });

  test("rejects disallowed metric name prefix", () => {
    expect(() =>
      prepareBatch(makeBody({ metricName: "evil.metric" }), baseOpts),
    ).toThrow(ValidationError);
  });

  test("strips device-unique resource attributes", () => {
    const out = prepareBatch(
      makeBody({
        resourceAttrs: [
          { key: "device.id", value: { stringValue: "abc-123" } },
          { key: "device.model", value: { stringValue: "Pixel 9" } },
        ],
      }),
      baseOpts,
    );
    const body = out.body as unknown as TestBody;
    const keys = body.resourceMetrics[0].resource.attributes.map((a) => a.key);
    expect(keys).not.toContain("device.id");
    expect(keys).toContain("device.model");
    expect(out.strippedAttrKeys).toEqual(["device.id"]);
  });

  test("strips data point attributes (PII cannot ride on points)", () => {
    const body = makeBody();
    body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes =
      [
        { key: "user.id", value: { stringValue: "u-123" } },
        { key: "wallet.address", value: { stringValue: "0xabc" } },
      ] as never;
    const out = prepareBatch(body, baseOpts);
    const fwd = out.body as unknown as TestBody;
    const dp = fwd.resourceMetrics[0].scopeMetrics[0].metrics[0].sum
      ?.dataPoints[0] as { attributes?: unknown[] };
    expect(dp.attributes ?? []).toEqual([]);
    expect(out.strippedPointAttrKeys).toEqual(
      expect.arrayContaining(["user.id", "wallet.address"]),
    );
  });

  test("strips scope attributes", () => {
    const body = makeBody();
    (
      body.resourceMetrics[0].scopeMetrics[0].scope as {
        attributes?: unknown[];
      }
    ).attributes = [{ key: "device.id", value: { stringValue: "abc" } }];
    const out = prepareBatch(body, baseOpts);
    const scope = (out.body as unknown as TestBody).resourceMetrics[0]
      .scopeMetrics[0] as { scope?: { attributes?: unknown[] } };
    expect(scope.scope?.attributes ?? []).toEqual([]);
  });

  test("strips unknown metric containers riding alongside a valid one", () => {
    const body = makeBody();
    const metric = body.resourceMetrics[0].scopeMetrics[0].metrics[0] as Record<
      string,
      unknown
    >;
    metric.exponentialHistogram = {
      dataPoints: [{ timeUnixNano: "1", attributes: [{ key: "user.id" }] }],
    };
    const out = prepareBatch(body, baseOpts);
    const fwd = (out.body as unknown as TestBody).resourceMetrics[0]
      .scopeMetrics[0].metrics[0] as Record<string, unknown>;
    expect(fwd.exponentialHistogram).toBeUndefined();
    expect(fwd.sum).toBeDefined(); // valid container untouched
    expect(out.droppedMetricKeys).toContain("exponentialHistogram");
  });

  test("summary-only metric is dropped, not forwarded raw", () => {
    const body = makeBody();
    const metric = body.resourceMetrics[0].scopeMetrics[0].metrics[0] as Record<
      string,
      unknown
    >;
    delete metric.sum;
    metric.summary = { dataPoints: [{ timeUnixNano: "1" }] };
    const out = prepareBatch(body, baseOpts);
    expect(out.isEmpty).toBe(true);
    expect(out.droppedMetricKeys).toContain("summary");
  });

  test("shifts timestamps by offsetMs (BigInt math)", () => {
    const out = prepareBatch(makeBody({ timeMs: NOW_MS - 60_000 }), {
      ...baseOpts,
      offsetMs: 5_000, // client clock 5s behind server
    });
    const body = out.body as unknown as TestBody;
    const dp =
      body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum!.dataPoints[0];
    expect(dp.timeUnixNano).toBe(ms(NOW_MS - 60_000 + 5_000).toString());
    expect(dp.startTimeUnixNano).toBe(
      ms(NOW_MS - 60_000 - 1000 + 5_000).toString(),
    );
  });

  test("negative offset shifts backward", () => {
    const out = prepareBatch(makeBody({ timeMs: NOW_MS - 60_000 }), {
      ...baseOpts,
      offsetMs: -5_000,
    });
    const body = out.body as unknown as TestBody;
    const dp =
      body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum!.dataPoints[0];
    expect(dp.timeUnixNano).toBe(ms(NOW_MS - 60_000 - 5_000).toString());
  });

  test("drops points older than 55min after shift; batch becomes empty", () => {
    const out = prepareBatch(
      makeBody({ timeMs: NOW_MS - 60 * 60_000 }),
      baseOpts,
    );
    expect(out.droppedStalePoints).toBe(1);
    expect(out.isEmpty).toBe(true);
  });

  test("point at exactly 54min survives", () => {
    const out = prepareBatch(
      makeBody({ timeMs: NOW_MS - 54 * 60_000 }),
      baseOpts,
    );
    expect(out.droppedStalePoints).toBe(0);
    expect(out.isEmpty).toBe(false);
  });

  test("histogram dataPoints are shifted too", () => {
    const body = makeBody();
    body.resourceMetrics[0].scopeMetrics[0].metrics = [
      {
        name: "api.authenticate",
        unit: "ms",
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [
            {
              startTimeUnixNano: ms(NOW_MS - 61_000).toString(),
              timeUnixNano: ms(NOW_MS - 60_000).toString(),
              count: "5",
              sum: 1234.5,
              bucketCounts: ["1", "4"],
              explicitBounds: [100],
              attributes: [],
            },
          ],
        },
      } as never,
    ];
    const out = prepareBatch(body, { ...baseOpts, offsetMs: 1_000 });
    const outBody = out.body as unknown as TestBody;
    const dp =
      outBody.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram!
        .dataPoints[0];
    expect(dp.timeUnixNano).toBe(ms(NOW_MS - 60_000 + 1_000).toString());
    expect(dp.bucketCounts).toEqual(["1", "4"]); // untouched
  });

  test("malformed body throws ValidationError", () => {
    expect(() => prepareBatch({ nope: true }, baseOpts)).toThrow(
      ValidationError,
    );
  });

  test("non-numeric timeUnixNano throws ValidationError", () => {
    const body = makeBody();
    body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].timeUnixNano =
      "not-a-number";
    expect(() => prepareBatch(body, baseOpts)).toThrow(ValidationError);
  });

  test("drops points dated far in the future", () => {
    // Point timestamp 1h ahead of receivedAt, no offset.
    const out = prepareBatch(
      makeBody({ timeMs: NOW_MS + 60 * 60_000 }),
      baseOpts,
    );
    expect(out.droppedStalePoints).toBe(1);
    expect(out.isEmpty).toBe(true);
  });

  test("unknown fields survive round-trip (passthrough)", () => {
    const body = makeBody() as Record<string, unknown> & {
      resourceMetrics: { schemaUrl?: string }[];
    };
    body.resourceMetrics[0].schemaUrl = "https://example.com/schema";
    const out = prepareBatch(body, baseOpts);
    const outBody = out.body as unknown as TestBody;
    expect(outBody.resourceMetrics[0].schemaUrl).toBe(
      "https://example.com/schema",
    );
  });

  test("allows session/storage/stream metric prefixes", () => {
    for (const name of [
      "session.delete_account",
      "storage.conversations.fetch",
      "stream.process_message",
    ]) {
      const out = prepareBatch(makeBody({ metricName: name }), baseOpts);
      expect(out.isEmpty).toBe(false);
    }
  });

  test("keeps the 'key' data point attribute", () => {
    const body = makeBody();
    body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes =
      [{ key: "key", value: { stringValue: "text/plain" } }] as never;
    const out = prepareBatch(body, baseOpts);
    const fwd = out.body as unknown as TestBody;
    const dp = fwd.resourceMetrics[0].scopeMetrics[0].metrics[0].sum
      ?.dataPoints[0] as { attributes?: { key: string }[] };
    expect(dp.attributes?.map((a) => a.key)).toEqual(["key"]);
    // only "key" present, nothing to strip
    expect(out.strippedPointAttrKeys).toEqual([]);
  });

  test("keeps the 'key' attribute on histogram data points too", () => {
    const body = makeBody();
    body.resourceMetrics[0].scopeMetrics[0].metrics = [
      {
        name: "api.authenticate",
        unit: "ms",
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [
            {
              startTimeUnixNano: ms(NOW_MS - 61_000).toString(),
              timeUnixNano: ms(NOW_MS - 60_000).toString(),
              count: "5",
              sum: 1234.5,
              bucketCounts: ["1", "4"],
              explicitBounds: [100],
              attributes: [
                { key: "key", value: { stringValue: "wifi" } },
                { key: "user.id", value: { stringValue: "u-123" } },
              ],
            },
          ],
        },
      } as never,
    ];
    const out = prepareBatch(body, baseOpts);
    const dp = (out.body as unknown as TestBody).resourceMetrics[0]
      .scopeMetrics[0].metrics[0].histogram!.dataPoints[0] as {
      attributes?: { key: string }[];
    };
    expect(dp.attributes?.map((a) => a.key)).toEqual(["key"]);
    expect(out.strippedPointAttrKeys).toEqual(["user.id"]);
  });
});
