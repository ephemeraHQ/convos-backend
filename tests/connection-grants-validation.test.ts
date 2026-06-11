import express from "express";
import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import { grantsPostHandler } from "@/api/v2/connections/handlers/grants-post";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

// Handler-level validation tests — no DB. Bundle-id validation fires BEFORE any
// prisma call, so a stub auth shim is enough; the happy path (which persists)
// lives in tests/connection-grants.test.ts (DB-backed, pnpm test:local).
function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use((_req, res, next) => {
    res.locals.accountId = "acct-validation-test";
    next();
  });
  app.post("/grants", grantsPostHandler);
  return app;
}

const BASE_BODY = {
  ownerInboxId: "owner-inbox",
  granteeInboxId: "agent-inbox",
  conversationId: "conv-1",
  toolkit: "googlecalendar",
};

describe("POST /v2/connections/grants — bundleIds validation (no DB)", () => {
  test("400 unknown_bundle for a bundle id missing from the toolkit's catalog", async () => {
    const res = await request(makeApp())
      .post("/grants")
      .send({ ...BASE_BODY, bundleIds: ["calendar.bogus"] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: "unknown_bundle",
      bundleId: "calendar.bogus",
    });
  });

  test("400 unknown_bundle when one id of several is unknown — names the bad one", async () => {
    // calendar.events.read is deprecated (hidden from the public catalog) yet
    // deliberately still KNOWN to validation — only calendar.nope is rejected.
    const res = await request(makeApp())
      .post("/grants")
      .send({
        ...BASE_BODY,
        bundleIds: ["calendar.events.read", "calendar.nope"],
      });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: "unknown_bundle",
      bundleId: "calendar.nope",
    });
  });

  test("400 unknown_bundle for bundleIds on a toolkit absent from the catalog", async () => {
    const res = await request(makeApp())
      .post("/grants")
      .send({
        ...BASE_BODY,
        toolkit: "notion",
        bundleIds: ["calendar.events"],
      });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: "unknown_bundle",
      bundleId: "calendar.events",
    });
  });
});
