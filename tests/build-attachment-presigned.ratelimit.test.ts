/**
 * Rate-limit coverage for GET /api/v2/agent-templates/attachments/presigned.
 * Mounts the real exported limiter in front of a trivial handler so the test
 * exercises its configured per-IP cap (20/min) without pulling in S3 or auth.
 */

import express from "express";
import request from "supertest";
import { expect, test } from "vitest";
import { buildAttachmentPresignedLimiter } from "@/middleware/rateLimit";

const app = express();
app.get("/presigned", buildAttachmentPresignedLimiter, (_req, res) => {
  res.json({ ok: true });
});

test("21st presigned request in the window → 429", async () => {
  // supertest drives every request from the same loopback IP, so they share
  // one counter. The first 20 are allowed; the 21st must be rejected.
  for (let i = 0; i < 20; i++) {
    const res = await request(app).get("/presigned");
    expect(res.status).toBe(200);
  }

  const limited = await request(app).get("/presigned");
  expect(limited.status).toBe(429);
  expect(limited.body).toEqual({
    error: "Too many attachment upload requests, please try again later",
  });
});
