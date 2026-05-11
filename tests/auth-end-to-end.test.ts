import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import cookieParser from "cookie-parser";
import { Wallet } from "ethers";
import express from "express";
import { SiweMessage } from "siwe";
import request from "supertest";
import { authRouter } from "@/api/v2/auth/auth.router";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";

function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.use(express.json());
  app.use(cookieParser());
  app.use("/auth", authRouter);
  app.get("/gated", authMiddleware, requireAccount, (_req, res) => {
    res.json({ ok: true, accountId: res.locals.accountId as string });
  });
  return app;
}

async function reset() {
  await prisma.authMethod.deleteMany();
  // Preserve the admin account seeded by migration; only wipe test-created rows.
  await prisma.account.deleteMany({ where: { id: { not: ADMIN_ACCOUNT_ID } } });
  await prisma.authNonce.deleteMany();
}

describe("auth end-to-end", () => {
  beforeAll(reset);
  afterEach(reset);

  test("nonce → SIWE → token → gated route", async () => {
    const app = makeApp();

    // 1. Get nonce
    const nonceRes = await request(app)
      .post("/auth/nonce")
      .set("X-Firebase-AppCheck", "valid-app-check-token");
    const setCookie = nonceRes.headers["set-cookie"] as string | string[];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr).toBeTruthy();
    const cookie = cookieStr.split(";")[0].trim();
    expect(cookie).toMatch(/^__Host-convos_nonce=/);

    const nonce = cookie.split(".").pop()!;

    // 2. Sign SIWE
    const wallet = new Wallet("0x" + "5".repeat(64));
    const msg = new SiweMessage({
      domain: "convos.app",
      address: wallet.address,
      statement: "Sign in to Convos",
      uri: "https://convos.app",
      version: "1",
      chainId: 1,
      nonce,
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const messageStr = msg.prepareMessage();
    const signature = await wallet.signMessage(messageStr);

    // 3. Token
    const tokenRes = await request(app)
      .post("/auth/token")
      .set("X-Firebase-AppCheck", "valid-app-check-token")
      .set("Cookie", cookie)
      .send({
        deviceId: "dev-e2e",
        siwe: { message: messageStr, signature },
      });
    expect(tokenRes.status).toBe(200);
    const tokenBody = tokenRes.body as { token: string };
    const token = tokenBody.token;
    expect(token).toBeTruthy();

    // 4. Gated route accepts
    const gatedRes = await request(app)
      .get("/gated")
      .set("X-Convos-AuthToken", token);
    expect(gatedRes.status).toBe(200);
    const gatedBody = gatedRes.body as { ok: boolean; accountId: string };
    expect(gatedBody.ok).toBe(true);
    expect(gatedBody.accountId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("legacy device-only token cannot reach gated route", async () => {
    const app = makeApp();
    const tokenRes = await request(app)
      .post("/auth/token")
      .set("X-Firebase-AppCheck", "valid-app-check-token")
      .send({ deviceId: "dev-legacy" });
    expect(tokenRes.status).toBe(200);
    const tokenBody = tokenRes.body as { token: string };

    const gatedRes = await request(app)
      .get("/gated")
      .set("X-Convos-AuthToken", tokenBody.token);
    expect(gatedRes.status).toBe(403);
    expect(gatedRes.body).toEqual({ error: "Account required" });
  });
});
