import { LedgerReason } from "@prisma/client";
import { afterEach, describe, expect, test } from "vitest";
import { applyDelta } from "@/payments/ledger/repository";
import { ValidationError } from "@/utils/errors";
import { prisma } from "@/utils/prisma";

const tracker: string[] = [];

afterEach(async () => {
  for (const accountId of tracker) {
    await prisma.creditLedger.deleteMany({ where: { accountId } });
    await prisma.userCredits.deleteMany({ where: { accountId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
  }
  tracker.length = 0;
});

async function seedAccount(): Promise<string> {
  const acct = await prisma.account.create({ data: {} });
  tracker.push(acct.id);
  return acct.id;
}

describe("idempotency-key enforcement at applyDelta", () => {
  test("a colon key throws ValidationError and writes no ledger row", async () => {
    const accountId = await seedAccount();
    await expect(
      applyDelta({
        accountId,
        delta: 10n,
        idempotencyKey: `bad:${accountId}:key`,
        reason: LedgerReason.adjust,
        scope: "grant",
      }),
    ).rejects.toThrow(ValidationError);
    const rows = await prisma.creditLedger.findMany({ where: { accountId } });
    expect(rows.length).toBe(0);
    const balanceRow = await prisma.userCredits.findUnique({
      where: { accountId },
    });
    expect(balanceRow).toBeNull();
  });

  test("an underscore key writes successfully", async () => {
    const accountId = await seedAccount();
    const result = await applyDelta({
      accountId,
      delta: 10n,
      idempotencyKey: `good_${accountId}_key`,
      reason: LedgerReason.adjust,
      scope: "grant",
    });
    expect(result.replayed).toBe(false);
    const rows = await prisma.creditLedger.findMany({ where: { accountId } });
    expect(rows.length).toBe(1);
  });
});
