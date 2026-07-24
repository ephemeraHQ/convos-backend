import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type * as DedupModule from "@/api/v2/telemetry/services/dedup";
import { releaseBatch } from "@/api/v2/telemetry/services/dedup";
import { forwardMetrics } from "@/api/v2/telemetry/services/forwarder";
import { telemetryRouter } from "@/api/v2/telemetry/telemetry.router";
import { appCheckOnlyMiddleware } from "@/middleware/auth";
import { errorHandlerMiddleware } from "@/middleware/errorHandler";
import { pinoMiddleware } from "@/middleware/pino";
import { countTelemetryBatch } from "@/utils/metrics";
import { prisma } from "@/utils/prisma";

// Mock App Check verification (network-free) and the forwarder (no agent).
vi.mock("@/utils/firebase", () => ({
  verifyAppCheckToken: vi
    .fn()
    .mockResolvedValue("1:226420087156:android:47e815c3b164a3b5c77421"),
}));
vi.mock("@/api/v2/telemetry/services/forwarder", () => ({
  forwardMetrics: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/utils/metrics", () => ({
  countTelemetryBatch: vi.fn(),
}));
// Real claim/release against the DB; releaseBatch is wrapped so a test can make
// one call fail and assert the handler retries it.
vi.mock("@/api/v2/telemetry/services/dedup", async (importOriginal) => {
  const actual = await importOriginal<typeof DedupModule>();
  return { ...actual, releaseBatch: vi.fn(actual.releaseBatch) };
});

function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.use("/telemetry", appCheckOnlyMiddleware, telemetryRouter);
  app.use(errorHandlerMiddleware);
  return app;
}

const BATCH_ID = "44444444-4444-4444-8444-444444444444";

function makeBody(timeMs = Date.now() - 60_000) {
  const nanos = (n: number) => (BigInt(n) * 1_000_000n).toString();
  return {
    resourceMetrics: [
      {
        resource: { attributes: [] },
        scopeMetrics: [
          {
            scope: { name: "convos-meters" },
            metrics: [
              {
                name: "api.auth_retry",
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      startTimeUnixNano: nanos(timeMs - 1000),
                      timeUnixNano: nanos(timeMs),
                      asInt: "1",
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

function post(app: express.Express) {
  return request(app)
    .post("/telemetry/metrics")
    .set("X-Firebase-AppCheck", "test-token")
    .set("Idempotency-Key", BATCH_ID)
    .set("X-Sent-At", new Date().toISOString());
}

describe("POST /telemetry/metrics", () => {
  beforeEach(async () => {
    await prisma.telemetryBatch.deleteMany();
    vi.mocked(forwardMetrics).mockClear();
    vi.mocked(forwardMetrics).mockResolvedValue(true);
    vi.mocked(countTelemetryBatch).mockClear();
    vi.mocked(releaseBatch).mockClear();
  });

  test("happy path → 202, forwarded, batch recorded", async () => {
    const res = await post(makeApp()).send(makeBody());
    expect(res.status).toBe(202);
    expect(forwardMetrics).toHaveBeenCalledTimes(1);
    expect(
      await prisma.telemetryBatch.findUnique({ where: { batchId: BATCH_ID } }),
    ).not.toBeNull();
    expect(countTelemetryBatch).toHaveBeenCalledTimes(1);
    expect(countTelemetryBatch).toHaveBeenCalledWith(
      "convos-android",
      "accepted",
    );
  });

  // service.name resource attribute of the first (only) forwarded batch.
  function forwardedServiceName(): string | undefined {
    const forwarded = vi.mocked(forwardMetrics).mock.calls[0][0] as {
      resourceMetrics: {
        resource: {
          attributes: { key: string; value: { stringValue: string } }[];
        };
      }[];
    };
    return forwarded.resourceMetrics[0].resource.attributes.find(
      (a) => a.key === "service.name",
    )?.value.stringValue;
  }

  test("service.name derived from android appId", async () => {
    await post(makeApp()).send(makeBody());
    expect(forwardedServiceName()).toBe("convos-android");
  });

  test("service.name derived from ios appId", async () => {
    const { verifyAppCheckToken } = await import("@/utils/firebase");
    vi.mocked(verifyAppCheckToken).mockResolvedValueOnce(
      "1:226420087156:ios:abc123def456",
    );
    await post(makeApp()).send(makeBody());
    expect(forwardedServiceName()).toBe("convos-ios");
    expect(countTelemetryBatch).toHaveBeenCalledTimes(1);
    expect(countTelemetryBatch).toHaveBeenCalledWith("convos-ios", "accepted");
  });

  test("X-Sent-At accepts an integer epoch-ms timestamp", async () => {
    const res = await request(makeApp())
      .post("/telemetry/metrics")
      .set("X-Firebase-AppCheck", "test-token")
      .set("Idempotency-Key", BATCH_ID)
      .set("X-Sent-At", String(Date.now()))
      .send(makeBody());
    expect(res.status).toBe(202);
    expect(forwardMetrics).toHaveBeenCalledTimes(1);
  });

  test("X-Sent-At accepts an integer epoch-ns timestamp", async () => {
    const res = await request(makeApp())
      .post("/telemetry/metrics")
      .set("X-Firebase-AppCheck", "test-token")
      .set("Idempotency-Key", BATCH_ID)
      .set("X-Sent-At", String(BigInt(Date.now()) * 1_000_000n))
      .send(makeBody());
    expect(res.status).toBe(202);
    expect(forwardMetrics).toHaveBeenCalledTimes(1);
  });

  test("non-numeric, non-date X-Sent-At → 400", async () => {
    const res = await request(makeApp())
      .post("/telemetry/metrics")
      .set("X-Firebase-AppCheck", "test-token")
      .set("Idempotency-Key", BATCH_ID)
      .set("X-Sent-At", "garbage")
      .send(makeBody());
    expect(res.status).toBe(400);
  });

  test("missing Idempotency-Key → 400", async () => {
    const res = await request(makeApp())
      .post("/telemetry/metrics")
      .set("X-Firebase-AppCheck", "test-token")
      .set("X-Sent-At", new Date().toISOString())
      .send(makeBody());
    expect(res.status).toBe(400);
    expect(countTelemetryBatch).toHaveBeenCalledTimes(1);
    expect(countTelemetryBatch).toHaveBeenCalledWith(
      "convos-android",
      "rejected",
    );
  });

  test("missing X-Sent-At → 400", async () => {
    const res = await request(makeApp())
      .post("/telemetry/metrics")
      .set("X-Firebase-AppCheck", "test-token")
      .set("Idempotency-Key", BATCH_ID)
      .send(makeBody());
    expect(res.status).toBe(400);
    expect(countTelemetryBatch).toHaveBeenCalledTimes(1);
    expect(countTelemetryBatch).toHaveBeenCalledWith(
      "convos-android",
      "rejected",
    );
  });

  test("duplicate batch → 202 without second forward", async () => {
    const app = makeApp();
    await post(app).send(makeBody());
    const res = await post(app).send(makeBody());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "duplicate" });
    expect(forwardMetrics).toHaveBeenCalledTimes(1);
    expect(countTelemetryBatch).toHaveBeenLastCalledWith(
      "convos-android",
      "duplicate",
    );
  });

  test("concurrent same-key requests forward exactly once", async () => {
    const app = makeApp();
    const [r1, r2] = await Promise.all([
      post(app).send(makeBody()),
      post(app).send(makeBody()),
    ]);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(forwardMetrics).toHaveBeenCalledTimes(1);
    const statuses = [r1, r2].map((r) => (r.body as { status: string }).status);
    expect(statuses.sort()).toEqual(["accepted", "duplicate"]);
  });

  test("400 rejection does not poison the Idempotency-Key", async () => {
    const app = makeApp();
    const bad = makeBody();
    bad.resourceMetrics[0].scopeMetrics[0].metrics[0].name = "evil.thing";
    expect((await post(app).send(bad)).status).toBe(400);
    const retry = await post(app).send(makeBody());
    expect(retry.status).toBe(202);
    expect(retry.body).toEqual({ status: "accepted" });
  });

  test("a failed release is retried, so a claim never strands until the TTL sweep", async () => {
    vi.mocked(forwardMetrics).mockResolvedValue(false);

    // The explicit release throws once, then the real delete runs. The finally
    // must retry it: if the handler counted the claim as released the moment it
    // *attempted* the delete, the row would survive and every retry of this
    // Idempotency-Key would be dropped as a duplicate until the 48h TTL sweep.
    vi.mocked(releaseBatch).mockRejectedValueOnce(
      new Error("transient db failure"),
    );

    await post(makeApp()).send(makeBody());

    expect(releaseBatch).toHaveBeenCalledTimes(2);
    expect(
      await prisma.telemetryBatch.findUnique({ where: { batchId: BATCH_ID } }),
    ).toBeNull();
  });

  test("forward failure → 502 and batch NOT recorded (retry stays possible)", async () => {
    vi.mocked(forwardMetrics).mockResolvedValue(false);
    const res = await post(makeApp()).send(makeBody());
    expect(res.status).toBe(502);
    expect(
      await prisma.telemetryBatch.findUnique({ where: { batchId: BATCH_ID } }),
    ).toBeNull();
    expect(countTelemetryBatch).toHaveBeenCalledTimes(1);
    expect(countTelemetryBatch).toHaveBeenCalledWith(
      "convos-android",
      "forward_failed",
    );
  });

  test("disallowed metric name → 400, nothing forwarded", async () => {
    const body = makeBody();
    body.resourceMetrics[0].scopeMetrics[0].metrics[0].name = "evil.thing";
    const res = await post(makeApp()).send(body);
    expect(res.status).toBe(400);
    expect(forwardMetrics).not.toHaveBeenCalled();
    expect(countTelemetryBatch).toHaveBeenCalledTimes(1);
    expect(countTelemetryBatch).toHaveBeenCalledWith(
      "convos-android",
      "rejected",
    );
  });

  test("malformed JSON body → 400 (not 500) and counted as rejected", async () => {
    const res = await post(makeApp())
      .set("Content-Type", "application/json")
      .send('{"resourceMetrics": [');
    expect(res.status).toBe(400);
    expect(forwardMetrics).not.toHaveBeenCalled();
    expect(countTelemetryBatch).toHaveBeenCalledTimes(1);
    expect(countTelemetryBatch).toHaveBeenCalledWith(
      "convos-android",
      "rejected",
    );
  });

  test("fully-stale batch → 202, recorded, nothing forwarded", async () => {
    const res = await post(makeApp()).send(
      makeBody(Date.now() - 2 * 60 * 60_000),
    );
    expect(res.status).toBe(202);
    expect(forwardMetrics).not.toHaveBeenCalled();
    expect(
      await prisma.telemetryBatch.findUnique({ where: { batchId: BATCH_ID } }),
    ).not.toBeNull();
  });

  test("oversize Content-Length → 413", async () => {
    const res = await post(makeApp())
      .set("Content-Length", "500000")
      .send(makeBody());
    expect(res.status).toBe(413);
  });

  test("body larger than the telemetry cap → 413 even with honest length", async () => {
    // ~300KB of attributes — exceeds TELEMETRY_MAX_BODY_BYTES (256KiB).
    const big = makeBody();
    const attrs = big.resourceMetrics[0].resource.attributes as {
      key: string;
      value: { stringValue: string };
    }[];
    for (let i = 0; i < 6000; i++) {
      attrs.push({ key: `os.version`, value: { stringValue: "x".repeat(40) } });
    }
    const res = await post(makeApp()).send(big);
    expect(res.status).toBe(413);
  });

  test("invalid App Check token → 401, nothing forwarded", async () => {
    const { verifyAppCheckToken } = await import("@/utils/firebase");
    vi.mocked(verifyAppCheckToken).mockRejectedValueOnce(
      new Error("invalid token"),
    );
    const res = await post(makeApp()).send(makeBody());
    expect(res.status).toBe(401);
    expect(forwardMetrics).not.toHaveBeenCalled();
  });
});
