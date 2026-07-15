import { randomUUID } from "node:crypto";
import express, { json } from "express";
import request from "supertest";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { accountsMeRouter } from "@/api/v2/accounts/accountsMeRouter";
import { authMiddleware } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import { setRuntimeConfig } from "@/utils/runtimeConfig";

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
  // Deletion ships default-OFF (rollout barrier); tests opt in explicitly.
  await setRuntimeConfig("account_deletion_enabled", "true");
});

describe("POST /v2/accounts/me/subscription/claim rate limiting", () => {
  test("11th request within the window is 429 with the contract envelope", async () => {
    const app = makeApp();
    // A live account: the deletion fence inside authMiddleware would 401 a
    // token for a nonexistent account before the limiters are reached.
    const account = await prisma.account.create({ data: {} });
    const token = await createJwtToken({
      deviceId: "dev-claim-rl",
      accountId: account.id,
    });
    // The per-IP budget is 10; requests before the cap fail closed at the
    // claim App Check gate (403, still counted — the limiters sit in
    // front). Loop until the cap trips and pin the envelope.
    let limited: request.Response | null = null;
    let appCheckRejected = 0;
    for (let i = 0; i < 12 && !limited; i += 1) {
      const res = await request(app)
        .post("/v2/accounts/me/subscription/claim")
        .set("X-Convos-AuthToken", token)
        .send({});
      if (res.status === 429) {
        limited = res;
      } else {
        expect(res.status).toBe(403);
        appCheckRejected += 1;
      }
    }
    expect(limited).not.toBeNull();
    expect(appCheckRejected).toBeGreaterThanOrEqual(9);
    expect(limited?.body).toEqual({
      error: "Too many subscription claim requests, please try again later",
    });
  });
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
