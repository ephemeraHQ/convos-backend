import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import cookieParser from "cookie-parser";
import { Wallet } from "ethers";
import express from "express";
import request from "supertest";
import { issueNonce } from "@/api/v2/auth/auth-nonce.repository";
import { authRouter } from "@/api/v2/auth/auth.router";
import { NONCE_COOKIE_NAME, signNonce } from "@/api/v2/auth/nonce-cookie";
import { pinoMiddleware } from "@/middleware/pino";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { verifyJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import { buildSiweMessage } from "./helpers/siwe";

function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.use(express.json());
  app.use(cookieParser());
  app.use("/auth", authRouter);
  return app;
}

const APPCHECK = ["X-Firebase-AppCheck", "valid-app-check-token"] as const;

async function buildSiwe(nonce: string, deviceId = "test-device-id") {
  const { messageStr, signature, address } = await buildSiweMessage({
    deviceId,
    nonce,
  });
  return { messageStr, signature, address };
}

async function reset() {
  await prisma.deviceRegistration.deleteMany();
  await prisma.authMethod.deleteMany();
  // Preserve the admin account seeded by migration; only wipe test-created rows.
  await prisma.account.deleteMany({ where: { id: { not: ADMIN_ACCOUNT_ID } } });
  await prisma.authNonce.deleteMany();
}

describe("POST /auth/token (legacy + SIWE)", () => {
  beforeAll(reset);
  afterEach(reset);

  test("no siwe → returns JWT { deviceId } (legacy path unchanged)", async () => {
    const res = await request(makeApp())
      .post("/auth/token")
      .set(...APPCHECK)
      .send({ deviceId: "dev-legacy" });

    expect(res.status).toBe(200);
    const body = res.body as { token: string };
    const payload = await verifyJwtToken({ token: body.token });
    expect(payload.deviceId).toBe("dev-legacy");
    expect(payload.accountId).toBeUndefined();
  });

  test("siwe happy path → upserts account, JWT carries accountId, clears cookie", async () => {
    const nonce = await issueNonce();
    const cookieValue = signNonce(nonce);
    const { messageStr, signature, address } = await buildSiwe(
      nonce,
      "dev-siwe",
    );

    const res = await request(makeApp())
      .post("/auth/token")
      .set(...APPCHECK)
      .set("Cookie", `${NONCE_COOKIE_NAME}=${cookieValue}`)
      .send({
        deviceId: "dev-siwe",
        siwe: { message: messageStr, signature },
      });

    expect(res.status).toBe(200);
    const body = res.body as { token: string };
    const payload = await verifyJwtToken({ token: body.token });
    expect(payload.deviceId).toBe("dev-siwe");
    expect(payload.accountId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const method = await prisma.authMethod.findFirst({
      where: { externalKey: address },
    });
    expect(method).not.toBeNull();

    const setCookie = res.headers["set-cookie"] as
      | string[]
      | string
      | undefined;
    const clearStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(clearStr).toContain("Max-Age=0");
  });

  test("replay: same nonce twice → 401 on second attempt", async () => {
    const nonce = await issueNonce();
    const cookieValue = signNonce(nonce);
    const { messageStr, signature } = await buildSiwe(nonce, "dev-replay");

    const first = await request(makeApp())
      .post("/auth/token")
      .set(...APPCHECK)
      .set("Cookie", `${NONCE_COOKIE_NAME}=${cookieValue}`)
      .send({
        deviceId: "dev-replay",
        siwe: { message: messageStr, signature },
      });
    expect(first.status).toBe(200);

    const second = await request(makeApp())
      .post("/auth/token")
      .set(...APPCHECK)
      .set("Cookie", `${NONCE_COOKIE_NAME}=${cookieValue}`)
      .send({
        deviceId: "dev-replay",
        siwe: { message: messageStr, signature },
      });
    expect(second.status).toBe(401);
  });

  test("siwe present but no cookie → 401", async () => {
    const nonce = "00".repeat(32);
    const { messageStr, signature } = await buildSiwe(nonce, "dev");
    const res = await request(makeApp())
      .post("/auth/token")
      .set(...APPCHECK)
      .send({ deviceId: "dev", siwe: { message: messageStr, signature } });
    expect(res.status).toBe(401);
  });

  test("JSON-prefixed nonce cookie (cookie-parser parses to object) → 401, not 500", async () => {
    const nonce = "00".repeat(32);
    const { messageStr, signature } = await buildSiwe(nonce, "dev");
    // cookie-parser parses values prefixed with `j:` as JSON. The cookie
    // value below decodes to {x:1}, a plain object. Without a string-type
    // guard the handler would crash; the contract is "treat as missing → 401".
    const jsonCookie = `j:${encodeURIComponent('{"x":1}')}`;
    const res = await request(makeApp())
      .post("/auth/token")
      .set(...APPCHECK)
      .set("Cookie", `${NONCE_COOKIE_NAME}=${jsonCookie}`)
      .send({ deviceId: "dev", siwe: { message: messageStr, signature } });
    expect(res.status).toBe(401);
  });

  test("tampered HMAC cookie → 401", async () => {
    const nonce = await issueNonce();
    const valid = signNonce(nonce);
    const tampered = "AAAA" + valid.slice(4);
    const { messageStr, signature } = await buildSiwe(nonce, "dev");
    const res = await request(makeApp())
      .post("/auth/token")
      .set(...APPCHECK)
      .set("Cookie", `${NONCE_COOKIE_NAME}=${tampered}`)
      .send({ deviceId: "dev", siwe: { message: messageStr, signature } });
    expect(res.status).toBe(401);
  });

  test("malformed body → 400", async () => {
    const res = await request(makeApp())
      .post("/auth/token")
      .set(...APPCHECK)
      .send({ deviceId: "" });
    expect(res.status).toBe(400);
  });

  test("disabled device → 403 even if SIWE present (device check before nonce consume)", async () => {
    await prisma.deviceRegistration.upsert({
      where: { deviceId: "dev-disabled" },
      create: { deviceId: "dev-disabled", disabled: true },
      update: { disabled: true },
    });

    const nonce = await issueNonce();
    const cookieValue = signNonce(nonce);
    const { messageStr, signature } = await buildSiwe(nonce, "dev-disabled");

    const res = await request(makeApp())
      .post("/auth/token")
      .set(...APPCHECK)
      .set("Cookie", `${NONCE_COOKIE_NAME}=${cookieValue}`)
      .send({
        deviceId: "dev-disabled",
        siwe: { message: messageStr, signature },
      });

    expect(res.status).toBe(403);

    // Nonce must NOT have been consumed — disabled check came first.
    const stillThere = await prisma.authNonce.findUnique({ where: { nonce } });
    expect(stillThere).not.toBeNull();

    await prisma.deviceRegistration.delete({
      where: { deviceId: "dev-disabled" },
    });
  });

  test("valid HMAC + bad SIWE signature → 401 AND nonce is consumed (locks in atomic-consume-before-verify ordering)", async () => {
    const nonce = await issueNonce();
    const cookieValue = signNonce(nonce);
    const { messageStr } = await buildSiwe(nonce, "dev-bad-sig");

    // Sign the same message with a different wallet so signature fails verifySiwe
    const otherWallet = new Wallet("0x" + "9".repeat(64));
    const badSignature = await otherWallet.signMessage(messageStr);

    const res = await request(makeApp())
      .post("/auth/token")
      .set(...APPCHECK)
      .set("Cookie", `${NONCE_COOKIE_NAME}=${cookieValue}`)
      .send({
        deviceId: "dev-bad-sig",
        siwe: { message: messageStr, signature: badSignature },
      });

    expect(res.status).toBe(401);

    // Nonce row must be gone — consume happened before verifySiwe.
    const row = await prisma.authNonce.findUnique({ where: { nonce } });
    expect(row).toBeNull();
  });
});
