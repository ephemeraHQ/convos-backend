import { describe, expect, test } from "bun:test";
import express from "express";
import request from "supertest";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken } from "@/utils/jwt";

/**
 * Behavioral tests for `GET /api/v2/account-auth-check`.
 *
 * The route is mounted in `src/api/v2/index.ts` with the
 * `authMiddleware + requireAccount` chain. These tests pin the
 * end-to-end contract iOS depends on:
 *
 *  - SIWE-bound JWT (carries `accountId`)          → 200
 *  - legacy device-only JWT (no `accountId`)       → 403 Account required
 *  - NSE-only JWT (`notificationExtensionOnly`)    → 403 NSE tokens not
 *                                                    allowed on this route
 *  - missing or invalid JWT                         → 401
 *
 * We mount the same middleware chain on a minimal Express app rather
 * than booting the full `v2Router` so the test stays focused on
 * middleware behavior; registration in `index.ts` is a single line and
 * easy to eyeball.
 */
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

describe("GET /account-auth-check", () => {
  test("200 with a SIWE-bound JWT (accountId present)", async () => {
    const accountId = "11111111-1111-1111-1111-111111111111";
    const token = await createJwtToken({ deviceId: "dev-siwe", accountId });

    const res = await request(makeApp())
      .get("/account-auth-check")
      .set("X-Convos-AuthToken", token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  test("403 Account required with a legacy device-only JWT", async () => {
    const token = await createJwtToken({ deviceId: "dev-legacy" });

    const res = await request(makeApp())
      .get("/account-auth-check")
      .set("X-Convos-AuthToken", token);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Account required" });
  });

  test("403 NSE tokens not allowed with an NSE-only JWT", async () => {
    // Backend mints these for the Notification Service Extension with
    // metadata.notificationExtensionOnly = true. They can hit
    // /auth-check (authMiddlewareAllowNSE) but must be rejected by
    // authMiddleware before they ever reach requireAccount.
    const token = await createJwtToken({
      deviceId: "dev-nse",
      metadata: { notificationExtensionOnly: true },
    });

    const res = await request(makeApp())
      .get("/account-auth-check")
      .set("X-Convos-AuthToken", token);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "NSE tokens not allowed on this route",
    });
  });

  test("401 when the X-Convos-AuthToken header is missing", async () => {
    const res = await request(makeApp()).get("/account-auth-check");
    expect(res.status).toBe(401);
  });

  test("401 when the token is not a valid JWT", async () => {
    const res = await request(makeApp())
      .get("/account-auth-check")
      .set("X-Convos-AuthToken", "not.a.jwt");
    expect(res.status).toBe(401);
  });
});
