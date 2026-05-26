import express, { json } from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { accountsMeRouter } from "@/api/v2/accounts/accountsMeRouter";
import { authMiddleware } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import {
  resetPlayApiClientForTests,
  setPlayApiFixtureForTests,
  type SubscriptionPurchaseV2,
} from "@/subscriptions/google-play/play-api";
import { PlaySubscriptionState } from "@/subscriptions/google-play/status";
import { BillingProvider } from "@/subscriptions/repository";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const makeApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.use("/v2/accounts/me", authMiddleware, accountsMeRouter);
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
  await prisma.billingReceipt.deleteMany({
    where: { subscription: { accountId: { in: createdAccountIds } } },
  });
  await prisma.subscription.deleteMany({
    where: { accountId: { in: createdAccountIds } },
  });
  await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  createdAccountIds.length = 0;
};

const fixturePurchase = (
  overrides: Partial<SubscriptionPurchaseV2> = {},
): SubscriptionPurchaseV2 => ({
  subscriptionState: PlaySubscriptionState.active,
  startTime: "2026-05-01T00:00:00.000Z",
  latestOrderId: "GPA.test-order",
  acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
  lineItems: [
    {
      productId: "app.convos.subs.pro.annual",
      expiryTime: "2027-05-01T00:00:00.000Z",
      autoRenewingPlan: { autoRenewEnabled: true },
    },
  ],
  externalAccountIdentifiers: { obfuscatedExternalAccountId: "obf-aaa" },
  ...overrides,
});

type VerifyBody = {
  subscription: {
    provider: string;
    tier: string;
    period: string;
    status: string;
    productId: string;
    currentPeriodEnd: string;
    willRenew: boolean;
    isInTrial: boolean;
  };
};

type ErrorBody = { error?: string; code?: string };

beforeAll(async () => {
  await validateJWTKeys();
  process.env.LOCAL_TESTING = "1";
});

afterEach(async () => {
  await wipe();
  resetPlayApiClientForTests();
  setPlayApiFixtureForTests(null);
});

describe("POST /v2/accounts/me/subscription/verify — Google Play branch", () => {
  test("happy path: creates a googlePlay Subscription row + returns DTO", async () => {
    setPlayApiFixtureForTests(() => fixturePurchase({}));
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({
        platform: "googlePlay",
        purchaseToken: "ptok-happy",
        productId: "app.convos.subs.pro.annual",
      });
    expect(res.status).toBe(200);
    expect((res.body as VerifyBody).subscription).toEqual({
      provider: "googlePlay",
      tier: "pro",
      period: "annual",
      status: "active",
      productId: "app.convos.subs.pro.annual",
      currentPeriodEnd: "2027-05-01T00:00:00.000Z",
      willRenew: true,
      isInTrial: false,
    });

    const persisted = await prisma.subscription.findFirst({
      where: { accountId, provider: BillingProvider.googlePlay },
    });
    expect(persisted?.purchaseToken).toBe("ptok-happy");
    expect(persisted?.obfuscatedAccountId).toBe("obf-aaa");
    expect(persisted?.environment).toBeNull();
  });

  test("rejects productId mismatch (client claimed different tier than Play recorded)", async () => {
    setPlayApiFixtureForTests(() =>
      fixturePurchase({
        lineItems: [
          {
            productId: "app.convos.subs.builder.monthly",
            expiryTime: "2026-06-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({
        platform: "googlePlay",
        purchaseToken: "ptok-mismatch",
        productId: "app.convos.subs.pro.annual",
      });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toMatch(/productId mismatch/);
  });

  test("rejects when Play purchase has no obfuscatedExternalAccountId", async () => {
    setPlayApiFixtureForTests(() =>
      fixturePurchase({ externalAccountIdentifiers: undefined }),
    );
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({
        platform: "googlePlay",
        purchaseToken: "ptok-no-obf",
        productId: "app.convos.subs.pro.annual",
      });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toMatch(
      /obfuscatedExternalAccountId/,
    );
  });

  test("cross-account re-verify rejected with 409", async () => {
    setPlayApiFixtureForTests(() => fixturePurchase({}));
    const accountA = await newAccount();
    const accountB = await newAccount();
    const tokA = await tokenFor(accountA);
    const tokB = await tokenFor(accountB);

    const firstRes = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", tokA)
      .send({
        platform: "googlePlay",
        purchaseToken: "ptok-shared",
        productId: "app.convos.subs.pro.annual",
      });
    expect(firstRes.status).toBe(200);

    const conflictRes = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", tokB)
      .send({
        platform: "googlePlay",
        purchaseToken: "ptok-shared",
        productId: "app.convos.subs.pro.annual",
      });
    expect(conflictRes.status).toBe(409);
    expect((conflictRes.body as ErrorBody).code).toBe(
      "subscription_account_mismatch",
    );
  });

  test("rejects extra body fields (discriminated body is strict)", async () => {
    setPlayApiFixtureForTests(() => fixturePurchase({}));
    const accountId = await newAccount();
    const token = await tokenFor(accountId);
    const res = await request(makeApp())
      .post("/v2/accounts/me/subscription/verify")
      .set("X-Convos-AuthToken", token)
      .send({
        platform: "googlePlay",
        purchaseToken: "ptok-extra",
        productId: "app.convos.subs.pro.annual",
        obfuscatedAccountId: "spoofed",
      });
    expect(res.status).toBe(400);
  });
});
