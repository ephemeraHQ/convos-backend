import { LedgerReason } from "@prisma/client";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import request from "supertest";
import { creditsMeRouter } from "@/api/v2/credits/credits-me.router";
import { authMiddleware } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import {
  AppleEnv,
  SubscriptionPeriod,
  SubscriptionStatus,
  SubscriptionTier,
  upsertFromVerify,
} from "@/subscriptions/repository";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

const makeApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(express.json());
  app.use("/v2/credits/me", authMiddleware, creditsMeRouter);
  return app;
};

const createdAccountIds: string[] = [];

const newAccount = async () => {
  const account = await prisma.account.create({ data: {} });
  createdAccountIds.push(account.id);
  return account.id;
};

const tokenFor = async (accountId: string) =>
  createJwtToken({ deviceId: `dev-${accountId.slice(0, 8)}`, accountId });

const wipe = async () => {
  if (createdAccountIds.length === 0) return;
  await prisma.appleReceipt.deleteMany({
    where: { subscription: { accountId: { in: createdAccountIds } } },
  });
  await prisma.subscription.deleteMany({
    where: { accountId: { in: createdAccountIds } },
  });
  await prisma.creditLedger.deleteMany({
    where: { accountId: { in: createdAccountIds } },
  });
  await prisma.userCredits.deleteMany({
    where: { accountId: { in: createdAccountIds } },
  });
  await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  createdAccountIds.length = 0;
};

beforeAll(async () => {
  await validateJWTKeys();
});

afterEach(async () => {
  await wipe();
});

const seedBuilderMonthly = async (accountId: string) =>
  upsertFromVerify({
    accountId,
    appAccountToken: `${accountId.slice(0, 8)}-2222-3333-4444-555555555555`,
    productId: "app.convos.subs.builder.monthly",
    tier: SubscriptionTier.builder,
    period: SubscriptionPeriod.monthly,
    status: SubscriptionStatus.active,
    originalTransactionId: `otid-${accountId}`,
    transactionId: `tx-${accountId}`,
    startedAt: new Date("2026-05-01T00:00:00.000Z"),
    currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
    willRenew: true,
    isInTrial: false,
    environment: AppleEnv.sandbox,
    signedPayload: "stub.jws",
  });

const writeConsume = async (
  accountId: string,
  credits: number,
  createdAt: Date,
  key: string,
) => {
  // Direct ledger write bypassing the service to control createdAt for tests.
  // Balance row needs to exist (FK to UserCredits is implicit via service flow,
  // but ledger doesn't FK to UserCredits — only to Account). Seed UserCredits
  // separately if not present to keep getBalance() happy.
  await prisma.userCredits.upsert({
    where: { accountId },
    update: { balance: { decrement: BigInt(credits) } },
    create: { accountId, balance: BigInt(-credits) },
  });
  await prisma.creditLedger.create({
    data: {
      accountId,
      delta: BigInt(-credits),
      reason: LedgerReason.consume,
      idempotencyKey: key,
      createdAt,
    },
  });
};

type BalanceBody = {
  balance: number;
  monthlyGrant: number;
  monthlyGrantUsed: number;
  nextRefreshAt: string;
  periodLabel: string;
};

describe("GET /v2/credits/me/balance", () => {
  test("returns 403 when JWT carries no accountId", async () => {
    const token = await createJwtToken({ deviceId: "dev-no-account" });
    const res = await request(makeApp())
      .get("/v2/credits/me/balance")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(403);
  });

  test("no subscription: returns zero-state shape with nextRefreshAt + periodLabel", async () => {
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/credits/me/balance")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
    const body = res.body as BalanceBody;
    expect(body.balance).toBe(0);
    expect(body.monthlyGrant).toBe(0);
    expect(body.monthlyGrantUsed).toBe(0);
    expect(typeof body.periodLabel).toBe("string");
    expect(body.periodLabel.length).toBeGreaterThan(0);
    expect(new Date(body.nextRefreshAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("active Builder monthly with zero consumes: balance == monthlyGrant", async () => {
    const accountId = await newAccount();
    await seedBuilderMonthly(accountId);
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/credits/me/balance")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrant).toBe(2500);
    expect(body.monthlyGrantUsed).toBe(0);
    expect(body.balance).toBe(2500);
    expect(body.nextRefreshAt).toBe("2026-06-01T00:00:00.000Z");
    expect(body.periodLabel).toBe("May 2026");
  });

  test("consumes within current period count against monthlyGrantUsed", async () => {
    const accountId = await newAccount();
    await seedBuilderMonthly(accountId);
    await writeConsume(
      accountId,
      300,
      new Date("2026-05-10T00:00:00.000Z"),
      "c1",
    );
    await writeConsume(
      accountId,
      200,
      new Date("2026-05-20T00:00:00.000Z"),
      "c2",
    );
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/credits/me/balance")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrantUsed).toBe(500);
    expect(body.balance).toBe(2500 - 500);
  });

  test("consumes before currentPeriodStart do NOT count (previous period burn)", async () => {
    const accountId = await newAccount();
    await seedBuilderMonthly(accountId);
    // Burn in the prior period — should not affect this period's display.
    await writeConsume(
      accountId,
      9999,
      new Date("2026-04-15T00:00:00.000Z"),
      "previous-period",
    );
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/credits/me/balance")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrantUsed).toBe(0);
    expect(body.balance).toBe(2500);
  });

  test("monthlyGrantUsed is capped at monthlyGrant (over-burn doesn't go negative)", async () => {
    const accountId = await newAccount();
    await seedBuilderMonthly(accountId);
    await writeConsume(
      accountId,
      9999,
      new Date("2026-05-15T00:00:00.000Z"),
      "huge",
    );
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/credits/me/balance")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrantUsed).toBe(2500);
    expect(body.balance).toBe(0);
  });

  test("Pro annual: monthlyGrant = 12 × monthly amount", async () => {
    const accountId = await newAccount();
    await upsertFromVerify({
      accountId,
      appAccountToken: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      productId: "app.convos.subs.pro.annual",
      tier: SubscriptionTier.pro,
      period: SubscriptionPeriod.annual,
      status: SubscriptionStatus.active,
      originalTransactionId: "otid-pro-annual",
      transactionId: "tx-pro-annual",
      startedAt: new Date("2026-05-01T00:00:00.000Z"),
      currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2027-05-01T00:00:00.000Z"),
      willRenew: true,
      isInTrial: false,
      environment: AppleEnv.sandbox,
      signedPayload: "stub.jws",
    });
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .get("/v2/credits/me/balance")
      .set("X-Convos-AuthToken", token);
    const body = res.body as BalanceBody;
    expect(body.monthlyGrant).toBe(10000 * 12);
    expect(body.balance).toBe(10000 * 12);
    expect(body.nextRefreshAt).toBe("2027-05-01T00:00:00.000Z");
  });
});
