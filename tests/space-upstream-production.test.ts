import express from "express";
import request from "supertest";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalXmtpEnv = process.env.XMTP_ENV;

afterEach(() => {
  process.env.XMTP_ENV = originalXmtpEnv;
  vi.resetModules();
});

describe("Space upstream production mount guard", () => {
  test("does not mount the debug route in production", async () => {
    process.env.XMTP_ENV = "production";
    vi.resetModules();
    const { default: v2Router } = await import("@/api/v2");
    const { pinoMiddleware } = await import("@/middleware/pino");
    const { createJwtToken, validateJWTKeys } = await import("@/utils/jwt");
    await validateJWTKeys();
    const token = await createJwtToken({
      deviceId: "production-mount-test",
      accountId: "11111111-1111-4111-8111-111111111111",
    });
    const app = express();
    app.use(pinoMiddleware);
    app.use("/api/v2", v2Router);

    const response = await request(app)
      .post("/api/v2/conversations/conversation_abc/debug/space-upstream")
      .set("X-Convos-AuthToken", token);
    expect(response.status).toBe(404);
  });
});
