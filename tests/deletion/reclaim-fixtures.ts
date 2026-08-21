/**
 * Slice-1 subset of the shared reclaim fixture module.
 * Later slices of the #374 split expand it to the full version.
 */
import { afterAll, afterEach, beforeAll } from "vitest";
import { validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const PERIOD_START = new Date(Date.now() - 5 * DAY_MS);
export const PERIOD_END = new Date(Date.now() + 25 * DAY_MS);
export const NEXT_PERIOD_END = new Date(PERIOD_END.getTime() + 30 * DAY_MS);
export const PRODUCT_ID = "app.convos.subs.monthly";

export const newAccount = async (lastAuthAt?: Date | null) => {
  const account = await prisma.account.create({
    data: {
      lastAuthAt:
        lastAuthAt === undefined ? new Date(Date.now() - HOUR_MS) : lastAuthAt,
    },
  });
  return account.id;
};

export const wipeReclaimState = async () => {
  await prisma.rateLimitCounter.deleteMany();
  await prisma.deletionTask.deleteMany();
  await prisma.deletionRecord.deleteMany();
  await prisma.deletedIdentity.deleteMany();
  await prisma.lineageQuarantine.deleteMany();
  await prisma.subscriptionDriftSchedule.deleteMany();
  await prisma.subscriptionTransfer.deleteMany();
  await prisma.lineagePeriodCustody.deleteMany();
  await prisma.lineagePeriodGrant.deleteMany();
  await prisma.lineageTokenAlias.deleteMany();
  await prisma.subscriptionLineage.deleteMany();
  await prisma.adminAudit.deleteMany();
  await prisma.billingReceipt.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.creditLedger.deleteMany();
  await prisma.userCredits.deleteMany();
  await prisma.deviceRegistration.deleteMany();
  await prisma.authMethod.deleteMany();
  await prisma.account.deleteMany({
    where: { id: { not: "48a05ef4-4a71-57a0-957f-a3d410992b31" } },
  });
};

export const installReclaimHooks = () => {
  let previousLocalTesting: string | undefined;

  beforeAll(async () => {
    await validateJWTKeys();
    previousLocalTesting = process.env.LOCAL_TESTING;
    process.env.LOCAL_TESTING = "1";
  });

  afterAll(() => {
    if (previousLocalTesting === undefined) {
      delete process.env.LOCAL_TESTING;
    } else {
      process.env.LOCAL_TESTING = previousLocalTesting;
    }
  });

  afterEach(wipeReclaimState);
};
