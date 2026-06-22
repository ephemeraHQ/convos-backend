import express, { json } from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { __setCronApiKeyOverrideForTests } from "@/api/v2/credits/middleware/cron-api-key";
import { reconcileRouter } from "@/api/v2/credits/reconcile.router";
import { pinoMiddleware } from "@/middleware/pino";

// Mock the service so the router test never touches providers or the DB —
// this isolates the cron-key gate + handler wiring.
const runEntitlementReconcile = vi.fn<() => Promise<unknown>>();
vi.mock("@/subscriptions/reconcile/service", () => ({
  runEntitlementReconcile: () => runEntitlementReconcile(),
}));

const TEST_CRON_KEY = "test-cron-api-key-that-is-at-least-32-characters-long";

const makeApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.use("/v2/credits", reconcileRouter);
  return app;
};

const okSummary = {
  runAt: new Date("2026-06-22T12:00:00.000Z"),
  scanned: 2,
  refreshed: [],
  noOp: 2,
  skipped: 0,
  errors: [],
};

beforeAll(() => {
  __setCronApiKeyOverrideForTests(TEST_CRON_KEY);
});

afterEach(() => {
  runEntitlementReconcile.mockReset();
});

describe("POST /v2/credits/reconcile auth gate", () => {
  test("missing cron key → 401, service not invoked", async () => {
    const res = await request(makeApp()).post("/v2/credits/reconcile");
    expect(res.status).toBe(401);
    expect(runEntitlementReconcile).not.toHaveBeenCalled();
  });

  test("wrong cron key → 401, service not invoked", async () => {
    const res = await request(makeApp())
      .post("/v2/credits/reconcile")
      .set("x-cron-api-key", "definitely-the-wrong-key-but-long-enough-xxxxx");
    expect(res.status).toBe(401);
    expect(runEntitlementReconcile).not.toHaveBeenCalled();
  });

  test("cron key unset → 503", async () => {
    __setCronApiKeyOverrideForTests(null);
    const res = await request(makeApp())
      .post("/v2/credits/reconcile")
      .set("x-cron-api-key", TEST_CRON_KEY);
    expect(res.status).toBe(503);
    expect(runEntitlementReconcile).not.toHaveBeenCalled();
    __setCronApiKeyOverrideForTests(TEST_CRON_KEY);
  });

  test("valid cron key → 200 with summary counts", async () => {
    runEntitlementReconcile.mockResolvedValue(okSummary);
    const res = await request(makeApp())
      .post("/v2/credits/reconcile")
      .set("x-cron-api-key", TEST_CRON_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      scanned: 2,
      refreshed: 0,
      noOp: 2,
      skipped: 0,
      errors: 0,
    });
    expect(runEntitlementReconcile).toHaveBeenCalledTimes(1);
  });

  test("service throws → 500", async () => {
    runEntitlementReconcile.mockRejectedValue(new Error("boom"));
    const res = await request(makeApp())
      .post("/v2/credits/reconcile")
      .set("x-cron-api-key", TEST_CRON_KEY);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "Entitlement reconcile failed" });
  });
});
