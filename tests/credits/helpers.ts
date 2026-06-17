import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import supertest from "supertest";
import { accountsByIdRouter } from "@/api/v2/accounts/accountsByIdRouter";
import { meGuard } from "@/api/v2/accounts/middleware/meGuard";
import { dailyRefillRouter } from "@/api/v2/credits/daily.router";
import {
  __setAgentAssetsApiKeyOverrideForTests,
  agentApiKeyAuth,
} from "@/middleware/agentAuth";
import { errorHandlerMiddleware } from "@/middleware/errorHandler";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { grant } from "@/payments";
import {
  AppleEnv,
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionPeriod,
  SubscriptionStatus,
  upsertFromVerify,
} from "@/subscriptions/repository";
import { prisma } from "@/utils/prisma";

export const TEST_AGENT_API_KEY =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

export const installAgentApiKeyOverride = (): void => {
  __setAgentAssetsApiKeyOverrideForTests(TEST_AGENT_API_KEY);
};

export const clearAgentApiKeyOverride = (): void => {
  __setAgentAssetsApiKeyOverrideForTests(undefined);
};

export const buildCreditsApp = (): express.Express => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use(
    "/v2/accounts/:accountId",
    agentApiKeyAuth,
    meGuard,
    accountsByIdRouter,
  );
  app.use("/api/v2/credits", dailyRefillRouter);
  app.use(noRouteMiddleware);
  app.use(errorHandlerMiddleware);
  return app;
};

export const seedAccount = async (): Promise<string> => {
  const acct = await prisma.account.create({ data: {} });
  return acct.id;
};

export const seedBalance = async (
  accountId: string,
  credits: bigint,
): Promise<void> => {
  if (credits <= 0n) {
    throw new Error(
      `seedBalance only supports positive credits; got ${credits}`,
    );
  }
  if (credits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `seedBalance credits exceeds Number.MAX_SAFE_INTEGER: ${credits}`,
    );
  }
  await grant({
    accountId,
    credits: Number(credits),
    kind: "manual",
    idempotencyKey: `seed-${accountId}-${randomUUID()}`,
  });
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const seedPlusMonthlySubscription = async (
  accountId: string,
): Promise<void> => {
  const now = Date.now();
  const start = new Date(now - 5 * DAY_MS);
  const end = new Date(now + 25 * DAY_MS);
  await upsertFromVerify({
    accountId,
    appAccountToken: randomUUID(),
    productId: "app.convos.subs.monthly",
    tier: SUBSCRIPTION_TIER_PLUS,
    period: SubscriptionPeriod.monthly,
    status: SubscriptionStatus.active,
    originalTransactionId: `otid-${accountId}`,
    transactionId: `tx-${accountId}`,
    startedAt: start,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    willRenew: true,
    isInTrial: false,
    environment: AppleEnv.sandbox,
    signedPayload: "stub.jws",
  });
};

export const seedExpiredSubscription = async (
  accountId: string,
): Promise<void> => {
  const now = Date.now();
  const start = new Date(now - 35 * DAY_MS);
  const end = new Date(now - 5 * DAY_MS);
  await upsertFromVerify({
    accountId,
    appAccountToken: randomUUID(),
    productId: "app.convos.subs.monthly",
    tier: SUBSCRIPTION_TIER_PLUS,
    period: SubscriptionPeriod.monthly,
    status: SubscriptionStatus.expired,
    originalTransactionId: `otid-exp-${accountId}`,
    transactionId: `tx-exp-${accountId}`,
    startedAt: start,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    willRenew: false,
    isInTrial: false,
    environment: AppleEnv.sandbox,
    signedPayload: "stub.jws",
  });
};

export const cleanupAccounts = async (accountIds: string[]): Promise<void> => {
  for (const accountId of accountIds) {
    await prisma.appleReceipt.deleteMany({
      where: { subscription: { accountId } },
    });
    await prisma.subscription.deleteMany({ where: { accountId } });
    await prisma.creditLedger.deleteMany({ where: { accountId } });
    await prisma.userCredits.deleteMany({ where: { accountId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
  }
};

export const agentRequest = (app: Express) => ({
  get: (path: string) =>
    supertest(app).get(path).set("X-Agent-API-Key", TEST_AGENT_API_KEY),
  post: (path: string, idempotencyKey: string, body: unknown) =>
    supertest(app)
      .post(path)
      .set("X-Agent-API-Key", TEST_AGENT_API_KEY)
      .set("Idempotency-Key", idempotencyKey)
      .send(body as object),
});
