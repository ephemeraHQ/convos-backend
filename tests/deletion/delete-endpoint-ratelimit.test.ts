import { randomUUID } from "node:crypto";
import express, { json } from "express";
import request from "supertest";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { accountsMeRouter } from "@/api/v2/accounts/accountsMeRouter";
import { authMiddleware } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

// Uses the real accountsMeRouter so the route wiring (limiters + handler on
// DELETE /) is what production serves. Kept in its own file: the limiter
// stores are per-process, so exhausting the per-IP budget here must not
// starve the functional tests in delete-account.test.ts.
const makeApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.use("/v2/accounts/me", authMiddleware, accountsMeRouter);
  return app;
};

beforeAll(async () => {
  await validateJWTKeys();
});

describe("DELETE /v2/accounts/me rate limiting", () => {
  test("6th request within the window is 429 with the contract envelope", async () => {
    const app = makeApp();
    const token = await createJwtToken({
      deviceId: "dev-rl",
      accountId: randomUUID(),
    });

    // Five requests consume the budget (the malformed body 400s are still
    // counted — the limiters sit in front of the handler).
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .delete("/v2/accounts/me")
        .set("X-Convos-AuthToken", token)
        .send({});
      expect(res.status).toBe(400);
    }

    const sixth = await request(app)
      .delete("/v2/accounts/me")
      .set("X-Convos-AuthToken", token)
      .send({});
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({
      error: "Too many account deletion requests, please try again later",
    });
    expect(sixth.headers).toHaveProperty("ratelimit");
  });
});
