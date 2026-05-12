import { beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import request from "supertest";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";

function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.get(
    "/account-auth-check",
    authMiddleware,
    requireAccount,
    (_req, res) => {
      res.status(200).json({ success: true });
    },
  );
  return app;
}

beforeAll(async () => {
  await validateJWTKeys();
});

describe("/account-auth-check", () => {
  test("SIWE-upgraded JWT (with accountId) → 200", async () => {
    const accountId = "33333333-3333-3333-3333-333333333333";
    const token = await createJwtToken({ deviceId: "dev-siwe", accountId });
    const res = await request(makeApp())
      .get("/account-auth-check")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  test("legacy device-only JWT (no accountId) → 403 Account required", async () => {
    const token = await createJwtToken({ deviceId: "dev-legacy" });
    const res = await request(makeApp())
      .get("/account-auth-check")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Account required" });
  });

  test("NSE token (notificationExtensionOnly) → 403 NSE rejected before requireAccount", async () => {
    // authMiddleware rejects NSE tokens at the first gate (defense-in-depth)
    // before requireAccount runs, so the error is "NSE tokens not allowed",
    // not "Account required".
    const token = await createJwtToken({
      deviceId: "dev-nse",
      metadata: { notificationExtensionOnly: true },
    });
    const res = await request(makeApp())
      .get("/account-auth-check")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "NSE tokens not allowed on this route" });
  });

  test("no token → 401 Missing auth token", async () => {
    const res = await request(makeApp()).get("/account-auth-check");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Missing auth token" });
  });
});
