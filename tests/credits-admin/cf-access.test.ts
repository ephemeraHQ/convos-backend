import express, { type Express } from "express";
import supertest from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  __setCfAccessDevFallbackForTests,
  CF_ACCESS_DEV_FALLBACK_EMAIL,
  CF_ACCESS_EMAIL_HEADER,
  cfAccessHeaderMiddleware,
} from "@/api/v2/credits-admin/middleware/cf-access";
import { errorHandlerMiddleware } from "@/middleware/errorHandler";
import { pinoMiddleware } from "@/middleware/pino";

const buildProbeApp = (): Express => {
  const app = express();
  app.use(pinoMiddleware);
  app.get("/probe", cfAccessHeaderMiddleware, (_req, res) => {
    res.status(200).json({ actorEmail: res.locals.actorEmail });
  });
  app.use(errorHandlerMiddleware);
  return app;
};

describe("cfAccessHeaderMiddleware", () => {
  let app: Express;
  beforeAll(() => {
    app = buildProbeApp();
  });
  afterEach(() => {
    __setCfAccessDevFallbackForTests(undefined);
  });

  it("passes and exposes actorEmail when header present", async () => {
    const res = await supertest(app)
      .get("/probe")
      .set(CF_ACCESS_EMAIL_HEADER, "admin@convos.test");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ actorEmail: "admin@convos.test" });
  });

  it("non-dev: missing header → 401, no actorEmail", async () => {
    __setCfAccessDevFallbackForTests(false);
    const res = await supertest(app).get("/probe");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: "unauthorized" });
  });

  it("dev: missing header → fallback label, 200", async () => {
    __setCfAccessDevFallbackForTests(true);
    const res = await supertest(app).get("/probe");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ actorEmail: CF_ACCESS_DEV_FALLBACK_EMAIL });
  });

  it("treats whitespace-only header as missing (non-dev → 401)", async () => {
    __setCfAccessDevFallbackForTests(false);
    const res = await supertest(app)
      .get("/probe")
      .set(CF_ACCESS_EMAIL_HEADER, "   ");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: "unauthorized" });
  });
});
