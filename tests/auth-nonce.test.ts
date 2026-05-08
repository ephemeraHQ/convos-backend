import { describe, expect, test } from "bun:test";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { authRouter } from "@/api/v2/auth/auth.router";
import { pinoMiddleware } from "@/middleware/pino";

function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.use(express.json());
  app.use(cookieParser());
  app.use("/auth", authRouter);
  return app;
}

describe("POST /auth/nonce", () => {
  test("issues a __Host-convos_nonce cookie with HttpOnly+Secure+SameSite+Path+Max-Age", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/auth/nonce")
      .set("X-Firebase-AppCheck", "valid-app-check-token");

    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr).toMatch(/^__Host-convos_nonce=/);
    expect(cookieStr).toContain("HttpOnly");
    expect(cookieStr).toContain("Secure");
    expect(cookieStr).toContain("SameSite=Strict");
    expect(cookieStr).toContain("Path=/");
    expect(cookieStr).toContain("Max-Age=300");
  });

  test("rejects without AppCheck token", async () => {
    const app = makeApp();
    const res = await request(app).post("/auth/nonce");
    expect(res.status).toBe(401);
  });
});
