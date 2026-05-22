import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { authRouter } from "@/api/v2/auth/auth.router";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";
import { buildSiweMessage } from "./helpers/siwe";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

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
  // CreditLedger + UserCredits hang off Account via FK. Wipe them first so the
  // subsequent Account.deleteMany() doesn't trip UserCredits_accountId_fkey
  // when prior tests in the run left credit rows behind.
  await prisma.creditLedger.deleteMany();
  await prisma.userCredits.deleteMany();
  // Preserve the admin account seeded by migration; only wipe test-created rows.
  await prisma.account.deleteMany({ where: { id: { not: ADMIN_ACCOUNT_ID } } });
  await prisma.authNonce.deleteMany();
  await prisma.deviceRegistration.deleteMany();
}

describe("auth end-to-end", () => {
  beforeAll(reset);
  afterEach(reset);

  test("nonce → SIWE → token → gated route", async () => {
    const app = makeApp();

    // Pre-create device row for assertion later.
    await prisma.deviceRegistration.create({
      data: { deviceId: "dev-e2e" },
    });

    // 1. Get nonce
    const nonceRes = await request(app)
      .post("/auth/nonce")
      .set("X-Firebase-AppCheck", "valid-app-check-token");
    expect(nonceRes.status).toBe(200);
    const setCookie = nonceRes.headers["set-cookie"] as string | string[];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr).toBeTruthy();
    const cookie = cookieStr.split(";")[0].trim();
    expect(cookie).toMatch(/^__Host-convos_nonce=/);

    const nonce = cookie.split(".").pop()!;

    // 2. Sign SIWE
    const { messageStr, signature } = await buildSiweMessage({
      deviceId: "dev-e2e",
      nonce,
      signerKey: "0x" + "5".repeat(64),
    });

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

    // Backfill check: DeviceRegistration row for dev-e2e should have
    // accountId equal to the minted account in the JWT.
    const deviceRow = await prisma.deviceRegistration.findUnique({
      where: { deviceId: "dev-e2e" },
    });
    expect(deviceRow).toBeTruthy();
    expect(deviceRow!.accountId).toBe(gatedBody.accountId);
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
