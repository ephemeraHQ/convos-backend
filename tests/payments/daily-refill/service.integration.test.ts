import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runDailyRefill } from "@/payments/daily-refill/service";
import { prisma } from "@/utils/prisma";

const tracker: string[] = [];

afterEach(async () => {
  for (const accountId of tracker) {
    await prisma.creditLedger.deleteMany({ where: { accountId } });
    await prisma.userCredits.deleteMany({ where: { accountId } });
    await prisma.authMethod.deleteMany({ where: { accountId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
  }
  tracker.length = 0;
});

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
