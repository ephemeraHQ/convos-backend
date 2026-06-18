import express, { type Express } from "express";
import supertest from "supertest";
import { creditsAdminRouter } from "@/api/v2/credits-admin/credits-admin.router";
import { CF_ACCESS_EMAIL_HEADER } from "@/api/v2/credits-admin/middleware/cf-access";
import { errorHandlerMiddleware } from "@/middleware/errorHandler";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";
import { cleanupAccounts } from "../credits/helpers";

export {
  seedAccount,
  seedBalance,
  seedPlusMonthlySubscription,
} from "../credits/helpers";

export const DEFAULT_ADMIN_EMAIL = "admin@convos.test";

export const buildCreditsAdminApp = (): Express => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use("/api/v2/credits-admin", creditsAdminRouter);
  app.use(noRouteMiddleware);
  app.use(errorHandlerMiddleware);
  return app;
};

export const adminRequest = (
  app: Express,
  email: string | null = DEFAULT_ADMIN_EMAIL,
) => ({
  get: (path: string) => {
    const r = supertest(app).get(path);
    return email === null ? r : r.set(CF_ACCESS_EMAIL_HEADER, email);
  },
  post: (path: string, body: unknown) => {
    const r = supertest(app)
      .post(path)
      .send(body as object);
    return email === null ? r : r.set(CF_ACCESS_EMAIL_HEADER, email);
  },
});

export const seedSiweAuthMethod = async (
  accountId: string,
  externalKey: string,
): Promise<void> => {
  await prisma.authMethod.create({
    data: { accountId, type: "SIWE", externalKey },
  });
};

export const cleanupAdminAccounts = async (
  accountIds: string[],
): Promise<void> => {
  for (const accountId of accountIds) {
    await prisma.adminAudit.deleteMany({ where: { accountId } });
    await prisma.authMethod.deleteMany({ where: { accountId } });
  }
  await cleanupAccounts(accountIds);
};
