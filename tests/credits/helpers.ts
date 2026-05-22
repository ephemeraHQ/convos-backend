import { randomUUID } from "node:crypto";
import express from "express";
import supertest from "supertest";
import type { Express } from "express";
import { creditsRouter } from "@/api/v2/credits/credits.router";
import { errorHandlerMiddleware } from "@/middleware/errorHandler";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { grant } from "@/payments";
import { prisma } from "@/utils/prisma";

export const TEST_AGENT_API_KEY =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

export const buildCreditsApp = (): express.Express => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use("/api/v2/credits", creditsRouter);
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

export const cleanupAccounts = async (accountIds: string[]): Promise<void> => {
  for (const accountId of accountIds) {
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
