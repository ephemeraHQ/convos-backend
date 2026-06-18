import express, { type Express } from "express";
import supertest from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeBearerTokenAuth } from "@/middleware/bearerTokenAuth";
import { errorHandlerMiddleware } from "@/middleware/errorHandler";
import { pinoMiddleware } from "@/middleware/pino";

const ENV = "TEST_BEARER_TOKEN";
const TOKEN = "x".repeat(40);

const buildApp = (): Express => {
  const app = express();
  app.use(pinoMiddleware);
  app.get("/probe", makeBearerTokenAuth(ENV), (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(errorHandlerMiddleware);
  return app;
};

describe("makeBearerTokenAuth", () => {
  let app: Express;
  beforeEach(() => {
    process.env[ENV] = TOKEN;
    app = buildApp();
  });
  afterEach(() => {
    Reflect.deleteProperty(process.env, ENV);
  });

  it("200 with correct Bearer token", async () => {
    const res = await supertest(app)
      .get("/probe")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("200 with raw token (no Bearer prefix)", async () => {
    const res = await supertest(app).get("/probe").set("Authorization", TOKEN);
    expect(res.status).toBe(200);
  });

  it("401 with wrong token", async () => {
    const res = await supertest(app)
      .get("/probe")
      .set("Authorization", "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("401 with no Authorization header", async () => {
    const res = await supertest(app).get("/probe");
    expect(res.status).toBe(401);
  });

  it("500 when env var unset", async () => {
    Reflect.deleteProperty(process.env, ENV);
    const res = await supertest(app)
      .get("/probe")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(500);
  });

  it("500 when token shorter than 32 chars", async () => {
    process.env[ENV] = "short";
    const res = await supertest(app)
      .get("/probe")
      .set("Authorization", "Bearer short");
    expect(res.status).toBe(500);
  });
});
