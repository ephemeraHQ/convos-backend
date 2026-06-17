import { randomUUID } from "node:crypto";
import { LedgerReason } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import { applyDelta } from "@/payments/ledger";
import { prisma } from "@/utils/prisma";
import { cleanupAccounts, seedAccount, seedBalance } from "./helpers";

const tracker: string[] = [];
afterEach(async () => {
  await cleanupAccounts(tracker);
  tracker.length = 0;
});

describe("applyDelta recordOnly", () => {
  it("writes a ledger row without moving UserCredits.balance (no row exists)", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);

    const key = `rec-${randomUUID()}`;
    const result = await applyDelta({
      accountId,
      delta: -500n,
      reason: LedgerReason.consume,
      idempotencyKey: key,
      scope: "transaction",
      recordOnly: true,
    });

    expect(result.replayed).toBe(false);
    expect(result.balanceAfter).toBe(0n);
    expect(result.newBalance).toBe(0n);

    const row = await prisma.creditLedger.findUnique({
      where: {
        accountId_idempotencyKey: { accountId, idempotencyKey: key },
      },
    });
    expect(row?.delta).toBe(-500n);
    expect(row?.balanceAfter).toBe(0n);

    // No balance moved → no UserCredits row created.
    const uc = await prisma.userCredits.findUnique({ where: { accountId } });
    expect(uc).toBeNull();
  });

  it("leaves an existing balance untouched and snapshots it", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 1000n);

    const key = `rec-${randomUUID()}`;
    await applyDelta({
      accountId,
      delta: -300n,
      reason: LedgerReason.consume,
      idempotencyKey: key,
      scope: "transaction",
      recordOnly: true,
    });

    const row = await prisma.creditLedger.findUnique({
      where: { accountId_idempotencyKey: { accountId, idempotencyKey: key } },
    });
    expect(row?.delta).toBe(-300n);
    expect(row?.balanceAfter).toBe(1000n);

    const uc = await prisma.userCredits.findUnique({ where: { accountId } });
    expect(uc?.balance).toBe(1000n); // unchanged
  });

  it("rejects recordOnly combined with floorCheck", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await expect(
      applyDelta({
        accountId,
        delta: -100n,
        reason: LedgerReason.consume,
        idempotencyKey: `rec-${randomUUID()}`,
        scope: "transaction",
        recordOnly: true,
        floorCheck: { minBalance: 0n },
      }),
    ).rejects.toThrow("recordOnly is incompatible with floorCheck");
  });

  it("is idempotent on replay (same key → prior row, still no balance move)", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const key = `rec-${randomUUID()}`;
    const input = {
      accountId,
      delta: -250n,
      reason: LedgerReason.consume,
      idempotencyKey: key,
      scope: "transaction" as const,
      recordOnly: true,
    };
    const first = await applyDelta(input);
    const second = await applyDelta(input);
    expect(second.replayed).toBe(true);
    expect(second.ledgerId).toBe(first.ledgerId);

    const count = await prisma.creditLedger.count({ where: { accountId } });
    expect(count).toBe(1);
    const uc = await prisma.userCredits.findUnique({ where: { accountId } });
    expect(uc).toBeNull();
  });
});
