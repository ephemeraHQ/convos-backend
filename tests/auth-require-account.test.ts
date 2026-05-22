import express from "express";
import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import { requireAccount } from "@/middleware/auth";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

describe("requireAccount middleware", () => {
  function makeApp(accountId?: string) {
    const app = express();
    app.use((_req, res, next) => {
      res.locals.accountId = accountId;
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

  test("200 when accountId present", async () => {
    const res = await request(makeApp("acct-1")).get("/gated");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
