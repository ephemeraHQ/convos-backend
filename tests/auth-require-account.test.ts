import express from "express";
import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import { requireAccount } from "@/middleware/auth";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

describe("requireAccount middleware", () => {
  function makeApp(accountId?: unknown) {
    const app = express();
    app.use((_req, res, next) => {
      res.locals.accountId = accountId as never;
      next();
    });
    app.get("/gated", requireAccount, (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  test("403 when accountId missing", async () => {
    const res = await request(makeApp(undefined)).get("/gated");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Account required" });
  });

  test("403 when accountId is empty string", async () => {
    const res = await request(makeApp("")).get("/gated");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Account required" });
  });

  test("403 when accountId is truthy but not a uuid", async () => {
    const res = await request(makeApp("acct-1")).get("/gated");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Account required" });
  });

  test("200 when accountId is a uuid", async () => {
    const res = await request(
      makeApp("11111111-1111-4111-8111-111111111111"),
    ).get("/gated");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test("warn log carries presence flag only, never the value", async () => {
    const warn = vi.fn();
    const app = express();
    app.use((req, res, next) => {
      (req as unknown as { log: { warn: typeof warn } }).log = { warn };
      res.locals.accountId = "super-secret-not-uuid";
      next();
    });
    app.get("/gated", requireAccount, (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get("/gated");
    expect(res.status).toBe(403);
    expect(warn).toHaveBeenCalledWith(
      { accountIdPresent: true },
      "requireAccount rejected request",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "super-secret-not-uuid",
    );
  });

  test("403 when accountId is not a string", async () => {
    const res = await request(makeApp(123)).get("/gated");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Account required" });
  });
});
