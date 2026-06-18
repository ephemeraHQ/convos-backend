import express, { type Express } from "express";
import {
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";
import supertest from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  __setCfIdentityForTests,
  attachActorIdentity,
  CF_IDENTITY_SENTINEL,
} from "@/api/v2/credits-admin/middleware/cf-identity";
import { errorHandlerMiddleware } from "@/middleware/errorHandler";
import { pinoMiddleware } from "@/middleware/pino";

const ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";
const AUD = "test-aud";

let privateKey: KeyLike;
let publicKey: KeyLike;
let wrongPrivateKey: KeyLike;

const signAssertion = (
  claims: Record<string, unknown>,
  aud: string = AUD,
  key: KeyLike = privateKey,
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);

const buildApp = (): Express => {
  const app = express();
  app.use(pinoMiddleware);
  app.get("/probe", attachActorIdentity, (_req, res) => {
    res.status(200).json({ actorEmail: res.locals.actorEmail });
  });
  app.use(errorHandlerMiddleware);
  return app;
};

const resolver: JWTVerifyGetKey = () => Promise.resolve(publicKey);

describe("attachActorIdentity", () => {
  let app: Express;
  beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair("RS256"));
    ({ privateKey: wrongPrivateKey } = await generateKeyPair("RS256"));
    app = buildApp();
  });
  afterEach(() => {
    __setCfIdentityForTests(undefined);
  });

  it("config absent + assertion absent → sentinel, 200", async () => {
    __setCfIdentityForTests({
      resolver: null,
      aud: AUD,
      requireIdentity: false,
    });
    const res = await supertest(app).get("/probe");
    expect(res.status).toBe(200);
    expect((res.body as { actorEmail: string }).actorEmail).toBe(
      CF_IDENTITY_SENTINEL,
    );
  });

  it("config absent + assertion present → sentinel, 200 (cannot verify)", async () => {
    __setCfIdentityForTests({
      resolver: null,
      aud: AUD,
      requireIdentity: false,
    });
    const token = await signAssertion({ email: "borja@convos.xyz" });
    const res = await supertest(app).get("/probe").set(ASSERTION_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as { actorEmail: string }).actorEmail).toBe(
      CF_IDENTITY_SENTINEL,
    );
  });

  it("config absent + require on → 500 misconfig", async () => {
    __setCfIdentityForTests({
      resolver: null,
      aud: AUD,
      requireIdentity: true,
    });
    const res = await supertest(app).get("/probe");
    expect(res.status).toBe(500);
  });

  it("config present + assertion absent + require off → sentinel, 200", async () => {
    __setCfIdentityForTests({ resolver, aud: AUD, requireIdentity: false });
    const res = await supertest(app).get("/probe");
    expect(res.status).toBe(200);
    expect((res.body as { actorEmail: string }).actorEmail).toBe(
      CF_IDENTITY_SENTINEL,
    );
  });

  it("config present + assertion absent + require on → 401", async () => {
    __setCfIdentityForTests({ resolver, aud: AUD, requireIdentity: true });
    const res = await supertest(app).get("/probe");
    expect(res.status).toBe(401);
  });

  it("valid assertion → verified email, 200", async () => {
    __setCfIdentityForTests({ resolver, aud: AUD, requireIdentity: false });
    const token = await signAssertion({ email: "borja@convos.xyz" });
    const res = await supertest(app).get("/probe").set(ASSERTION_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as { actorEmail: string }).actorEmail).toBe(
      "borja@convos.xyz",
    );
  });

  it("valid signature but empty email → 401 (fail closed)", async () => {
    __setCfIdentityForTests({ resolver, aud: AUD, requireIdentity: false });
    const token = await signAssertion({ email: "" });
    const res = await supertest(app).get("/probe").set(ASSERTION_HEADER, token);
    expect(res.status).toBe(401);
  });

  it("wrong audience → 401", async () => {
    __setCfIdentityForTests({ resolver, aud: AUD, requireIdentity: false });
    const token = await signAssertion(
      { email: "borja@convos.xyz" },
      "other-aud",
    );
    const res = await supertest(app).get("/probe").set(ASSERTION_HEADER, token);
    expect(res.status).toBe(401);
  });

  it("bad signature → 401", async () => {
    __setCfIdentityForTests({ resolver, aud: AUD, requireIdentity: false });
    const token = await signAssertion(
      { email: "borja@convos.xyz" },
      AUD,
      wrongPrivateKey,
    );
    const res = await supertest(app).get("/probe").set(ASSERTION_HEADER, token);
    expect(res.status).toBe(401);
  });

  it("expired assertion → 401", async () => {
    __setCfIdentityForTests({ resolver, aud: AUD, requireIdentity: false });
    const token = await new SignJWT({ email: "borja@convos.xyz" })
      .setProtectedHeader({ alg: "RS256" })
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("-5m")
      .sign(privateKey);
    const res = await supertest(app).get("/probe").set(ASSERTION_HEADER, token);
    expect(res.status).toBe(401);
  });
});
