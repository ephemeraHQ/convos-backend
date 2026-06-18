import express, { type Express } from "express";
import { generateKeyPair, SignJWT, type KeyLike } from "jose";
import supertest from "supertest";
import { __setCfIdentityForTests } from "@/api/v2/credits-admin/middleware/cf-identity";
import { creditsAdminRouter } from "@/api/v2/credits-admin/credits-admin.router";
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

export const TEST_ADMIN_TOKEN = "test-credits-admin-token-0123456789abcdef";

export const buildCreditsAdminApp = (): Express => {
  process.env.CREDITS_ADMIN_API_TOKEN = TEST_ADMIN_TOKEN;
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use("/api/v2/credits-admin", creditsAdminRouter);
  app.use(noRouteMiddleware);
  app.use(errorHandlerMiddleware);
  return app;
};

/**
 * authed=true (default) sends the admin Bearer token. authed=false sends no
 * credential (expect 401). Identity defaults to the sentinel path (no CF
 * assertion configured); tests needing a verified email use seedCfIdentity().
 */
export const adminRequest = (app: Express, authed: boolean = true) => ({
  get: (path: string) => {
    const r = supertest(app).get(path);
    return authed ? r.set("Authorization", `Bearer ${TEST_ADMIN_TOKEN}`) : r;
  },
  post: (path: string, body: unknown) => {
    const r = supertest(app)
      .post(path)
      .send(body as object);
    return authed ? r.set("Authorization", `Bearer ${TEST_ADMIN_TOKEN}`) : r;
  },
});

let _cfKeys: { privateKey: KeyLike; publicKey: KeyLike } | undefined;

/**
 * Arm the CF identity verifier with a local key pair so mutation tests can
 * assert a verified actorEmail. Returns a signer for a valid assertion.
 */
export const seedCfIdentity = async (
  aud: string = "test-aud",
): Promise<(email: string) => Promise<string>> => {
  if (!_cfKeys) _cfKeys = await generateKeyPair("RS256");
  const { privateKey, publicKey } = _cfKeys;
  __setCfIdentityForTests({
    resolver: async () => publicKey,
    aud,
    requireIdentity: false,
  });
  return (email: string) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256" })
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
};

export const clearCfIdentity = (): void => __setCfIdentityForTests(undefined);

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
