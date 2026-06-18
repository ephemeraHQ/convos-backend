/**
 * Rate-limit coverage for GET /api/v2/agent-templates/attachments/presigned.
 * Mounts the real exported limiter in front of a trivial handler so the test
 * exercises its configured per-IP cap (20/min) and its auth-aware `skip`
 * without pulling in S3. The skip keys on `res.locals.isApiKeyListener`, so a
 * one-line middleware that sets it stands in for the agent-API-key auth path.
 */

import express from "express";
import request from "supertest";
import { expect, test } from "vitest";
import { buildAttachmentPresignedLimiter } from "@/middleware/rateLimit";

const anonApp = express();
anonApp.get("/presigned", buildAttachmentPresignedLimiter, (_req, res) => {
  res.json({ ok: true });
});

test("anonymous: 21st presigned request in the window → 429", async () => {
  // No res.locals.accountId → the limiter does not skip. supertest drives every
  // request from the same loopback IP, so they share one counter: the first 20
  // are allowed; the 21st must be rejected.
  for (let i = 0; i < 20; i++) {
    const res = await request(anonApp).get("/presigned");
    expect(res.status).toBe(200);
  }

  const limited = await request(anonApp).get("/presigned");
  expect(limited.status).toBe(429);
  expect(limited.body).toEqual({
    error: "Too many attachment upload requests, please try again later",
  });
});

test("agent API key caller: requests bypass the per-IP cap", async () => {
  // Stand in for the auth chain: set res.locals.isApiKeyListener before the
  // limiter, as optionalAuthOrAgentApiKeyAuth does for the agent-API-key path.
  const apiKeyApp = express();
  apiKeyApp.get(
    "/presigned",
    (_req, res, next) => {
      res.locals.isApiKeyListener = true;
      next();
    },
    buildAttachmentPresignedLimiter,
    (_req, res) => {
      res.json({ ok: true });
    },
  );

  // Well past the cap of 20 — every request still passes because the limiter
  // skips the agent-API-key caller (and never increments the counter).
  for (let i = 0; i < 25; i++) {
    const res = await request(apiKeyApp).get("/presigned");
    expect(res.status).toBe(200);
  }
});

test("signed-in (JWT) caller stays capped: 21st request → 429", async () => {
  // A JWT caller has res.locals.accountId set but NOT isApiKeyListener, so the
  // skip does not fire — only the agent-API-key path is exempt.
  //
  // The limiter store is shared across this file's apps and keyed on req.ip;
  // the anonymous test already exhausted the loopback counter, so route this
  // test through a distinct client IP (trust proxy + X-Forwarded-For) to get an
  // independent counter.
  const jwtApp = express();
  jwtApp.set("trust proxy", true);
  jwtApp.get(
    "/presigned",
    (_req, res, next) => {
      res.locals.accountId = "test-account-id";
      next();
    },
    buildAttachmentPresignedLimiter,
    (_req, res) => {
      res.json({ ok: true });
    },
  );

  const asJwtClient = () =>
    request(jwtApp).get("/presigned").set("X-Forwarded-For", "203.0.113.7");

  for (let i = 0; i < 20; i++) {
    const res = await asJwtClient();
    expect(res.status).toBe(200);
  }
  const limited = await asJwtClient();
  expect(limited.status).toBe(429);
});
