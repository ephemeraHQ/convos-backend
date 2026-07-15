import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  barIdentityWithTx,
  isIdentityBarred,
} from "@/accounts/deletion/barrier";
import { hashDeletedIdentity } from "@/accounts/deletion/identity-hash";
import {
  AccountNotLiveError,
  requireLiveAccount,
} from "@/accounts/require-live-account";
import { issueNonce } from "@/api/v2/auth/auth-nonce.repository";
import { authRouter } from "@/api/v2/auth/auth.router";
import { NONCE_COOKIE_NAME, signNonce } from "@/api/v2/auth/nonce-cookie";
import { pinoMiddleware } from "@/middleware/pino";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";
import { buildSiweMessage } from "../helpers/siwe";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.use(express.json());
  app.use(cookieParser());
  app.use("/auth", authRouter);
  return app;
}

const APPCHECK = ["X-Firebase-AppCheck", "valid-app-check-token"] as const;

async function mintWithSiwe(deviceId: string, signerKey?: string) {
  const nonce = await issueNonce();
  const { messageStr, signature, address } = await buildSiweMessage({
    deviceId,
    nonce,
    signerKey,
  });
  const res = await request(makeApp())
    .post("/auth/token")
    .set(...APPCHECK)
    .set("Cookie", `${NONCE_COOKIE_NAME}=${signNonce(nonce)}`)
    .send({ deviceId, siwe: { message: messageStr, signature } });
  return { res, address };
}

async function reset() {
  await prisma.deviceRegistration.deleteMany();
  await prisma.authMethod.deleteMany();
  await prisma.creditLedger.deleteMany();
  await prisma.userCredits.deleteMany();
  await prisma.account.deleteMany({ where: { id: { not: ADMIN_ACCOUNT_ID } } });
  await prisma.authNonce.deleteMany();
  await prisma.deletedIdentity.deleteMany();
}

describe("deletion barrier at token mint", () => {
  beforeAll(reset);
  afterEach(reset);

  test("barred identity: 410 identity_deleted, no account, no signup bonus", async () => {
    // Bar the identity before it ever mints (the address the default test
    // signer produces), then attempt a fully-valid SIWE mint.
    const probe = await buildSiweMessage({
      deviceId: "dev-barred",
      nonce: "0".repeat(64),
    });
    await prisma.$transaction((tx) =>
      barIdentityWithTx(tx, { type: "SIWE", externalKey: probe.address }),
    );

    const { res, address } = await mintWithSiwe("dev-barred");

    expect(res.status).toBe(410);
    expect(res.body).toEqual({
      error: "This identity has been deleted",
      code: "identity_deleted",
    });
    // No account/auth-method auto-provisioned, no signup bonus granted.
    expect(
      await prisma.authMethod.count({ where: { externalKey: address } }),
    ).toBe(0);
    expect(
      await prisma.account.count({ where: { id: { not: ADMIN_ACCOUNT_ID } } }),
    ).toBe(0);
    expect(await prisma.creditLedger.count()).toBe(0);
  });

  test("barrier hash is case-insensitive on the external key", async () => {
    const lower = "0x" + "ab".repeat(20);
    const upper = "0x" + "AB".repeat(20);
    expect(hashDeletedIdentity("SIWE", lower)).toBe(
      hashDeletedIdentity("SIWE", upper),
    );
    await prisma.$transaction((tx) =>
      barIdentityWithTx(tx, { type: "SIWE", externalKey: upper }),
    );
    expect(await isIdentityBarred("SIWE", lower)).toBe(true);
  });

  test("unbarred mint succeeds and stamps lastAuthAt", async () => {
    const before = new Date();
    const { res, address } = await mintWithSiwe("dev-live");
    expect(res.status).toBe(200);

    const method = await prisma.authMethod.findFirst({
      where: { externalKey: address },
    });
    expect(method).not.toBeNull();
    const account = await prisma.account.findUnique({
      where: { id: method?.accountId },
    });
    expect(account?.lastAuthAt).not.toBeNull();
    expect(account?.lastAuthAt?.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
  });

  test("barIdentityWithTx is idempotent", async () => {
    const externalKey = "0x" + "cd".repeat(20);
    await prisma.$transaction((tx) =>
      barIdentityWithTx(tx, { type: "SIWE", externalKey }),
    );
    await expect(
      prisma.$transaction((tx) =>
        barIdentityWithTx(tx, { type: "SIWE", externalKey }),
      ),
    ).resolves.not.toThrow();
    expect(await prisma.deletedIdentity.count()).toBe(1);
  });
});

describe("requireLiveAccount", () => {
  afterEach(reset);

  test("passes for a live account", async () => {
    const account = await prisma.account.create({ data: {} });
    await expect(
      prisma.$transaction((tx) => requireLiveAccount(tx, account.id)),
    ).resolves.toBeUndefined();
  });

  test("throws AccountNotLiveError when the account row is gone", async () => {
    const account = await prisma.account.create({ data: {} });
    await prisma.account.delete({ where: { id: account.id } });
    await expect(
      prisma.$transaction((tx) => requireLiveAccount(tx, account.id)),
    ).rejects.toBeInstanceOf(AccountNotLiveError);
  });
});
