import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { serviceNameFor } from "@/api/v2/telemetry/handlers/metrics";
import { forwardTraces } from "@/api/v2/telemetry/services/trace-forwarder";
import { sanitizeTraces } from "@/api/v2/telemetry/services/trace-sanitize";
import { telemetryRouter } from "@/api/v2/telemetry/telemetry.router";
import { ENV } from "@/config";
import { appCheckOnlyMiddleware } from "@/middleware/auth";
import { errorHandlerMiddleware } from "@/middleware/errorHandler";
import { pinoMiddleware } from "@/middleware/pino";
import { countTelemetryBatch } from "@/utils/metrics";

vi.mock("@/utils/firebase", () => ({
  verifyAppCheckToken: vi
    .fn()
    .mockResolvedValue("1:226420087156:android:47e815c3b164a3b5c77421"),
}));
vi.mock("@/api/v2/telemetry/services/trace-forwarder", () => ({
  forwardTraces: vi.fn().mockResolvedValue({ ok: true, permanent: false }),
}));
vi.mock("@/utils/metrics", () => ({ countTelemetryBatch: vi.fn() }));

function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.use("/telemetry", appCheckOnlyMiddleware, telemetryRouter);
  app.use(errorHandlerMiddleware);
  return app;
}

function makeBody(
  resourceAttrs = [{ key: "device.id", value: { stringValue: "abc" } }],
) {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: "convos-traces" },
            spans: [
              {
                name: "agent.join",
                traceId: "a".repeat(32),
                spanId: "b".repeat(16),
                startTimeUnixNano: "1",
                endTimeUnixNano: "2",
                attributes: [],
                kind: 1,
                status: { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Body builder that exercises the three extra attribute containers:
 *  scope.attributes, span.events[].attributes, span.links[].attributes.
 *  Each carries a PII attr ("device.id") and an allowed one ("convos.flavor"). */
function makeBodyWithEventLinkScopeAttrs() {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            scope: {
              name: "convos-traces",
              attributes: [
                { key: "device.id", value: { stringValue: "scope-pii" } },
                { key: "convos.flavor", value: { stringValue: "nightly" } },
              ],
            },
            spans: [
              {
                name: "agent.join",
                traceId: "a".repeat(32),
                spanId: "b".repeat(16),
                startTimeUnixNano: "1",
                endTimeUnixNano: "2",
                attributes: [
                  { key: "convos.flavor", value: { stringValue: "nightly" } },
                ],
                kind: 1,
                status: { code: 0 },
                events: [
                  {
                    name: "exception",
                    timeUnixNano: "3",
                    attributes: [
                      {
                        key: "device.id",
                        value: { stringValue: "event-pii" },
                      },
                      {
                        key: "convos.flavor",
                        value: { stringValue: "nightly" },
                      },
                    ],
                  },
                ],
                links: [
                  {
                    traceId: "c".repeat(32),
                    spanId: "d".repeat(16),
                    attributes: [
                      {
                        key: "device.id",
                        value: { stringValue: "link-pii" },
                      },
                      {
                        key: "convos.flavor",
                        value: { stringValue: "nightly" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function post(app: express.Express) {
  return request(app)
    .post("/telemetry/traces")
    .set("X-Firebase-AppCheck", "test-token");
}

type Attr = { key: string; value?: { stringValue?: string } };

// Loose shape of the body handed to forwardTraces, covering every attribute
// container the sanitizer walks. One declaration the tests share instead of
// re-casting mock.calls[0][0] with a bespoke partial type per assertion.
type ForwardedTraces = {
  resourceSpans: {
    resource?: { attributes?: Attr[] };
    scopeSpans: {
      scope?: { attributes?: Attr[] };
      spans: {
        name: string;
        attributes?: Attr[];
        events?: { attributes?: Attr[] }[];
        links?: { attributes?: Attr[] }[];
      }[];
    }[];
  }[];
};

/** The body passed to the (mocked) forwardTraces on its first call. */
const forwarded = () =>
  vi.mocked(forwardTraces).mock.calls[0]?.[0] as ForwardedTraces;

/** The `key`s of an attribute list (absent list → []). */
const keysOf = (attrs?: Attr[]) => (attrs ?? []).map((a) => a.key);

/** The first span of the first scope of the first resource in [fwd]. */
const firstSpan = (fwd: ForwardedTraces) =>
  fwd.resourceSpans[0].scopeSpans[0].spans[0];

describe("POST /telemetry/traces", () => {
  // Restore the success default before EVERY test. mockClear() alone only wipes
  // call history and keeps the implementation, so a table row that sets
  // mockResolvedValue({ ok: false, ... }) would leak its failure result into
  // every later test (the accepted-path assertions would then run against the
  // wrong flow). mockReset() drops the stale implementation; we re-arm the
  // happy-path default here so each test starts from a known-good state and
  // only the failure-path tests opt into a different result.
  beforeEach(() => {
    vi.mocked(forwardTraces).mockReset();
    vi.mocked(forwardTraces).mockResolvedValue({ ok: true, permanent: false });
    vi.mocked(countTelemetryBatch).mockClear();
  });

  test("happy path → 202 and forwarded", async () => {
    const res = await post(makeApp()).send(makeBody());
    expect(res.status).toBe(202);
    expect(forwardTraces).toHaveBeenCalledTimes(1);
  });

  // forwardTraces outcome → HTTP status the client keys retry behaviour off.
  test.each([
    ["transient forward failure (5xx/network) → 502", false, 502],
    ["permanent forward failure (agent 4xx) → 400", true, 400],
  ])("%s", async (_label, permanent, status) => {
    vi.mocked(forwardTraces).mockResolvedValue({ ok: false, permanent });
    const res = await post(makeApp()).send(makeBody());
    expect(res.status).toBe(status);
  });

  test("invalid App Check token → 401", async () => {
    const { verifyAppCheckToken } = await import("@/utils/firebase");
    vi.mocked(verifyAppCheckToken).mockRejectedValueOnce(new Error("bad"));
    const res = await post(makeApp()).send(makeBody());
    expect(res.status).toBe(401);
    expect(forwardTraces).not.toHaveBeenCalled();
  });

  // Every terminal path increments convos_backend.telemetry.batches_received
  // exactly once, tagged by client + outcome — same invariant as the metrics
  // route, so the /traces leg is visible in pipeline-health metrics.
  test.each([
    ["accepted (202)", () => post(makeApp()).send(makeBody()), "accepted"],
    [
      "rejected (invalid body → 400)",
      () => post(makeApp()).send({ invalid: "body" }),
      "rejected",
    ],
    [
      "forward_failed (transient → 502)",
      () => {
        vi.mocked(forwardTraces).mockResolvedValue({
          ok: false,
          permanent: false,
        });
        return post(makeApp()).send(makeBody());
      },
      "forward_failed",
    ],
    [
      "forward_failed (permanent → 400)",
      () => {
        vi.mocked(forwardTraces).mockResolvedValue({
          ok: false,
          permanent: true,
        });
        return post(makeApp()).send(makeBody());
      },
      "forward_failed",
    ],
  ])("counts the batch as %s", async (_label, run, outcome) => {
    // beforeEach restores the success default; each row's `run` opts into its
    // own failure result where needed.
    await run();
    expect(countTelemetryBatch).toHaveBeenCalledTimes(1);
    expect(countTelemetryBatch).toHaveBeenCalledWith("convos-android", outcome);
  });

  // Resource-attribute allowlist: PII stripped, allowed key kept, in one pass.
  test("resource attributes: strips device.id, keeps allowlisted", async () => {
    await post(makeApp()).send(
      makeBody([
        { key: "device.id", value: { stringValue: "abc" } },
        { key: "os.version", value: { stringValue: "14" } },
      ]),
    );
    const keys = keysOf(forwarded().resourceSpans[0].resource?.attributes);
    expect(keys).not.toContain("device.id");
    expect(keys).toContain("os.version");
  });

  // Span-level attribute allowlist across the three nested containers: each
  // drops the PII attr (device.id) and keeps the allowed one (convos.flavor).
  // scope.attributes is denied wholesale, so it has no surviving keys at all.
  test.each([
    [
      "scope.attributes",
      (f: ForwardedTraces) =>
        f.resourceSpans[0].scopeSpans[0].scope?.attributes,
      false, // convos.flavor does NOT survive — scope is emptied by deny-by-default
    ],
    [
      "span.events[].attributes",
      (f: ForwardedTraces) => firstSpan(f).events?.[0]?.attributes,
      true,
    ],
    [
      "span.links[].attributes",
      (f: ForwardedTraces) => firstSpan(f).links?.[0]?.attributes,
      true,
    ],
  ] as const)(
    "%s: strips device.id, applies allowlist",
    async (_label, get, keepsFlavor) => {
      await post(makeApp()).send(makeBodyWithEventLinkScopeAttrs());
      const keys = keysOf(get(forwarded()));
      expect(keys).not.toContain("device.id");
      if (keepsFlavor) {
        expect(keys).toContain("convos.flavor");
      } else {
        // deny-by-default: scope.attributes is emptied entirely.
        expect(keys).toHaveLength(0);
      }
    },
  );

  test("overrides client-supplied service.name with server-derived value", async () => {
    // Client tries to spoof service.name; server must override it from the
    // verified App Check appId (android → "convos-android").
    await post(makeApp()).send(
      makeBody([
        { key: "service.name", value: { stringValue: "spoofed" } },
        { key: "os.version", value: { stringValue: "14" } },
      ]),
    );
    const attrs = forwarded().resourceSpans[0].resource?.attributes ?? [];
    const serviceNameAttrs = attrs.filter((a) => a.key === "service.name");
    expect(serviceNameAttrs).toHaveLength(1);
    expect(serviceNameAttrs[0].value?.stringValue).toBe(
      serviceNameFor("1:226420087156:android:47e815c3b164a3b5c77421"),
    );
    expect(serviceNameAttrs[0].value?.stringValue).toBe("convos-android");
  });

  test("stamps deployment.environment server-side", async () => {
    await post(makeApp()).send(
      makeBody([
        { key: "deployment.environment", value: { stringValue: "spoofed" } },
      ]),
    );
    const attrs = forwarded().resourceSpans[0].resource?.attributes ?? [];
    const envAttrs = attrs.filter((a) => a.key === "deployment.environment");
    expect(envAttrs).toHaveLength(1);
    expect(envAttrs[0].value?.stringValue).toBe(ENV);
  });

  test("server attribution applies even when resource.attributes is missing", async () => {
    const body = makeBody();
    // Drop the resource entirely; attribution must still be applied.
    delete (body.resourceSpans[0] as { resource?: unknown }).resource;
    await post(makeApp()).send(body);
    const keys = keysOf(forwarded().resourceSpans[0].resource?.attributes);
    expect(keys).toContain("service.name");
    expect(keys).toContain("deployment.environment");
  });

  test("unknown span name is dropped (span-name allowlist)", async () => {
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: { name: "convos-traces" },
              spans: [
                {
                  name: "agent.join",
                  traceId: "a".repeat(32),
                  spanId: "b".repeat(16),
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "2",
                  attributes: [],
                  kind: 1,
                  status: { code: 0 },
                },
                {
                  name: "evil.custom.name",
                  traceId: "c".repeat(32),
                  spanId: "d".repeat(16),
                  startTimeUnixNano: "3",
                  endTimeUnixNano: "4",
                  attributes: [],
                  kind: 1,
                  status: { code: 0 },
                },
              ],
            },
          ],
        },
      ],
    };
    await post(makeApp()).send(body);
    const names = forwarded().resourceSpans[0].scopeSpans[0].spans.map(
      (s) => s.name,
    );
    expect(names).toContain("agent.join");
    expect(names).not.toContain("evil.custom.name");
    expect(names).toHaveLength(1);
  });

  test("sanitizeTraces returns the dropped span names (observability)", () => {
    // The span-name allowlist drop is deliberate but must be observable, not
    // silent — sanitizeTraces returns the dropped names so the handler can log
    // them. Each unknown name is reported once.
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: { name: "convos-traces" },
              spans: [
                { name: "agent.join", attributes: [] },
                { name: "evil.custom.name", attributes: [] },
                { name: "another.bad.name", attributes: [] },
              ],
            },
          ],
        },
      ],
    };
    const { droppedSpanNames } = sanitizeTraces(body);
    expect(droppedSpanNames.sort()).toEqual([
      "another.bad.name",
      "evil.custom.name",
    ]);
    // The allowlisted span is not reported as dropped.
    expect(droppedSpanNames).not.toContain("agent.join");
  });

  test("missing resourceSpans → 400", async () => {
    // forwardTraces defaults to succeeding, so the 400 is unambiguously from
    // input validation, not from a forwarding failure.
    const res = await post(makeApp()).send({ invalid: "body" });
    expect(res.status).toBe(400);
    expect(forwardTraces).not.toHaveBeenCalled();
  });

  // Malformed-shape regressions: each mutation forced a 500 (or a sanitization
  // bypass) before its fix. The contract is uniform — untrusted junk never
  // crashes the route. `bypassable` rows additionally assert that the valid
  // sibling is still sanitized (device.id stripped, server attrs stamped),
  // proving the malformed element didn't fail the parse and forward raw.
  test.each<[string, (b: ReturnType<typeof makeBody>) => void, boolean]>([
    [
      // non-array attributes hits the Array.isArray guard
      "non-array resource.attributes",
      (b) => {
        (
          b.resourceSpans[0].resource as unknown as { attributes: unknown }
        ).attributes = { "device.id": "abc" };
      },
      false,
    ],
    [
      // primitive resource hits the applyServerResourceAttributes shape-guard
      "primitive resource",
      (b) => {
        (b.resourceSpans[0] as unknown as { resource: unknown }).resource = 1;
      },
      false,
    ],
    [
      // null scopeSpans element: tolerantArray(scopeSpans) must drop it
      "null scopeSpans element",
      (b) => {
        (b.resourceSpans[0] as { scopeSpans: unknown[] }).scopeSpans.unshift(
          null,
        );
      },
      true,
    ],
    [
      // null resourceSpans element: tolerantArray(resourceSpans) must drop it
      "null resourceSpans element",
      (b) => {
        (b as { resourceSpans: unknown[] }).resourceSpans.unshift(null);
      },
      true,
    ],
  ])(
    "malformed input (%s) does not 500",
    async (_label, mutate, bypassable) => {
      const body = makeBody();
      mutate(body);
      const res = await post(makeApp()).send(body);
      expect(res.status).not.toBe(500);
      expect(res.status).toBeLessThan(500);
      if (bypassable) {
        // The surviving valid element must still be sanitized, not forwarded raw.
        const survivor = forwarded().resourceSpans.find(
          (rs) => rs.resource?.attributes,
        );
        const keys = keysOf(survivor?.resource?.attributes);
        expect(keys).not.toContain("device.id");
        expect(keys).toContain("service.name");
      }
    },
  );

  test("a primitive resource drops only the bad field, not the spans", async () => {
    // Regression: a malformed `resource` (e.g. the primitive 1) must NOT fail
    // its resourceSpans element and discard every valid span beneath it. The
    // tolerant `resource` field is coerced away, the element + its spans survive,
    // and attribution is re-stamped onto a fresh resource.
    const body = makeBody();
    (body.resourceSpans[0] as unknown as { resource: unknown }).resource = 1;
    await post(makeApp()).send(body);
    const fwd = forwarded();
    expect(fwd.resourceSpans).toHaveLength(1);
    // The span survived (not dropped with the bad resource)…
    const names = fwd.resourceSpans[0].scopeSpans[0].spans.map((s) => s.name);
    expect(names).toContain("agent.join");
    // …and attribution was re-applied to a repaired resource.
    const keys = keysOf(fwd.resourceSpans[0].resource?.attributes);
    expect(keys).toContain("service.name");
  });

  test("null/malformed elements in attribute arrays do not crash (no 500)", async () => {
    const body = {
      resourceSpans: [
        {
          resource: {
            // null, a valid allowlisted attr, and a non-object string — all junk except device.id
            attributes: [null, { key: "device.id", value: {} }, "notanobject"],
          },
          scopeSpans: [
            {
              scope: { name: "convos-traces" },
              spans: [
                // null span element must be dropped, not cause a crash
                null,
                {
                  name: "agent.join",
                  traceId: "a".repeat(32),
                  spanId: "b".repeat(16),
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "2",
                  // span attributes containing null
                  attributes: [
                    null,
                    { key: "convos.flavor", value: { stringValue: "nightly" } },
                  ],
                  kind: 1,
                  status: { code: 0 },
                  events: [
                    // null event element must not crash
                    null,
                    {
                      name: "e",
                      timeUnixNano: "3",
                      attributes: [
                        null,
                        {
                          key: "convos.flavor",
                          value: { stringValue: "nightly" },
                        },
                      ],
                    },
                  ],
                  links: [
                    // null link element must not crash
                    null,
                    {
                      traceId: "c".repeat(32),
                      spanId: "d".repeat(16),
                      attributes: [
                        null,
                        {
                          key: "convos.flavor",
                          value: { stringValue: "nightly" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const res = await post(makeApp()).send(body);
    // Must not surface a thrown 500 — null elements must be dropped cleanly.
    expect(res.status).not.toBe(500);
    expect(res.status).toBeLessThan(500);

    // The allowlisted convos.flavor should survive in span/event/link attrs;
    // the null + junk entries should have been dropped.
    const span = firstSpan(forwarded());
    expect(keysOf(span.attributes)).toContain("convos.flavor");
    expect(keysOf(span.events?.[0]?.attributes)).toContain("convos.flavor");
    expect(keysOf(span.links?.[0]?.attributes)).toContain("convos.flavor");
  });
});
