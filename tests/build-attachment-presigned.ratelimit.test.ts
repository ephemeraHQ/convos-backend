/**
 * Rate-limit coverage for GET /api/v2/agent-templates/attachments/presigned.
 * Mounts the real exported limiter in front of a trivial handler so the test
 * exercises its configured per-IP cap (20/min) and its auth-aware `skip`
 * without pulling in S3. The skip keys on `res.locals.accountId`, so a one-line
 * middleware that sets it stands in for the real auth chain.
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

test("authenticated: requests bypass the per-IP cap", async () => {
  // Stand in for the auth chain: set res.locals.accountId before the limiter,
  // as optionalAuthOrAgentApiKeyAuth does for an agent-key or JWT caller.
  const authedApp = express();
  authedApp.get(
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

  // Well past the anonymous cap of 20 — every request still passes because the
  // limiter skips authenticated callers (and never increments the counter).
  for (let i = 0; i < 25; i++) {
    const res = await request(authedApp).get("/presigned");
    expect(res.status).toBe(200);
  }
});
