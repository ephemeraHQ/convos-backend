import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runDailyRefill } from "@/payments/daily-refill/service";
import { prisma } from "@/utils/prisma";

const tracker: string[] = [];

afterEach(async () => {
  for (const accountId of tracker) {
    await prisma.subscription.deleteMany({ where: { accountId } });
    await prisma.creditLedger.deleteMany({ where: { accountId } });
    await prisma.userCredits.deleteMany({ where: { accountId } });
    await prisma.authMethod.deleteMany({ where: { accountId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
  }
  tracker.length = 0;
});

async function seedAccount(opts?: { withAuthMethod?: boolean }): Promise<string> {
  const acct = await prisma.account.create({ data: {} });
  tracker.push(acct.id);
  if (opts?.withAuthMethod ?? true) {
    await prisma.authMethod.create({
      data: {
        accountId: acct.id,
        type: "SIWE",
        externalKey: `0x${randomUUID().replace(/-/g, "")}`,
      },
    });
  }
  return acct.id;
}

async function seedActiveSubscription(accountId: string): Promise<void> {
  await prisma.subscription.create({
    data: {
      accountId,
      productId: "com.example.builder.monthly",
      tier: "builder",
      period: "monthly",
      status: "active",
      originalTransactionId: `otx-${randomUUID()}`,
      appAccountToken: randomUUID(),
      startedAt: new Date("2026-05-01"),
      currentPeriodStart: new Date("2026-05-01"),
      currentPeriodEnd: new Date("2026-06-01"),
      environment: "production",
    },
  });
}

const NOW = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));

describe("runDailyRefill — empty DB", () => {
  test("no eligible accounts → empty summary", async () => {
    const summary = await runDailyRefill({
      now: new Date(Date.UTC(2026, 4, 15, 12, 0, 0)),
    });
    expect(summary.skipped).toBe(false);
    expect(summary.refilled).toEqual([]);
    expect(summary.noOp).toBe(0);
    expect(summary.errors).toEqual([]);
  });
});

describe("runDailyRefill — eligibility", () => {
  test("includes SIWE-verified non-subscriber", async () => {
    const accountId = await seedAccount();
    const summary = await runDailyRefill({ now: NOW });
    expect(summary.refilled.map((r) => r.accountId)).toContain(accountId);
  });

  test("excludes account without AuthMethod (anonymous device-only)", async () => {
    const accountId = await seedAccount({ withAuthMethod: false });
    const summary = await runDailyRefill({ now: NOW });
    expect(summary.refilled.map((r) => r.accountId)).not.toContain(accountId);
  });

  test("excludes account with active subscription", async () => {
    const accountId = await seedAccount();
    await seedActiveSubscription(accountId);
    const summary = await runDailyRefill({ now: NOW });
    expect(summary.refilled.map((r) => r.accountId)).not.toContain(accountId);
  });

  test("includes account whose subscription is revoked (non-active status)", async () => {
    const accountId = await seedAccount();
    await prisma.subscription.create({
      data: {
        accountId,
        productId: "com.example.builder.monthly",
        tier: "builder",
        period: "monthly",
        status: "revoked",
        originalTransactionId: `otx-${randomUUID()}`,
        appAccountToken: randomUUID(),
        startedAt: new Date("2026-04-01"),
        currentPeriodStart: new Date("2026-04-01"),
        currentPeriodEnd: new Date("2026-05-01"),
        environment: "production",
      },
    });
    const summary = await runDailyRefill({ now: NOW });
    expect(summary.refilled.map((r) => r.accountId)).toContain(accountId);
  });
});
