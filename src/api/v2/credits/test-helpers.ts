import express from "express";
import { errorHandlerMiddleware } from "@/middleware/errorHandler";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";
import { creditsRouter } from "./credits.router";

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
  balance: bigint,
): Promise<void> => {
  await prisma.userCredits.create({
    data: { accountId, balance },
  });
};

export const cleanupAccounts = async (accountIds: string[]): Promise<void> => {
  for (const accountId of accountIds) {
    await prisma.creditLedger.deleteMany({ where: { accountId } });
    await prisma.userCredits.deleteMany({ where: { accountId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
  }
};
