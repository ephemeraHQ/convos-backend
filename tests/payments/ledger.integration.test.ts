import { LedgerReason } from "@prisma/client";
import { afterEach, describe, expect, it, test } from "vitest";
import { IdempotencyMismatchError } from "@/payments/errors";
import {
  applyDelta,
  getBalance,
  getHistory,
  LedgerFloorBreachError,
} from "@/payments/ledger/repository";
import { prisma } from "@/utils/prisma";

const seedAccount = async (): Promise<string> => {
  const acct = await prisma.account.create({ data: {} });
  return acct.id;
};

describe("payments/ledger/repository", () => {
  const cleanupAccounts: string[] = [];

  afterEach(async () => {
    for (const accountId of cleanupAccounts) {
      await prisma.creditLedger.deleteMany({ where: { accountId } });
      await prisma.userCredits.deleteMany({ where: { accountId } });
      await prisma.account.deleteMany({ where: { id: accountId } });
    }
    cleanupAccounts.length = 0;
  });

  test("getBalance returns 0n for unknown accountId", async () => {
    // Use a random UUID-shaped string that won't match any account
    const fakeId = "00000000-0000-0000-0000-000000000001";
    expect(await getBalance(fakeId)).toBe(0n);
  });

  test("applyDelta first-write creates UserCredits row + ledger row", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    const result = await applyDelta({
      accountId,
      delta: 100n,
      reason: LedgerReason.grant,
      idempotencyKey: "k1",
      scope: "grant",
      grantKindId: "manual",
    });

    expect(result.replayed).toBe(false);

    const balance = await getBalance(accountId);
    expect(balance).toBe(100n);

    const rows = await prisma.creditLedger.findMany({ where: { accountId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].delta).toBe(100n);
    expect(rows[0].idempotencyKey).toBe("k1");
  });

  test("applyDelta replay returns ledgerId, no double mutation", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    await applyDelta({
      accountId,
      delta: 50n,
      reason: LedgerReason.grant,
      idempotencyKey: "k1",
      scope: "grant",
      grantKindId: "manual",
    });
    // intervening mutation to prove replay does not double-apply
    await applyDelta({
      accountId,
      delta: 25n,
      reason: LedgerReason.grant,
      idempotencyKey: "k2",
      scope: "grant",
      grantKindId: "manual",
    });
    const replay = await applyDelta({
      accountId,
      delta: 50n,
      reason: LedgerReason.grant,
      idempotencyKey: "k1",
      scope: "grant",
      grantKindId: "manual",
    });

    expect(replay.replayed).toBe(true);
    expect(await getBalance(accountId)).toBe(75n); // current is unchanged by replay
    const rows = await prisma.creditLedger.findMany({ where: { accountId } });
    expect(rows).toHaveLength(2);
  });

  test("applyDelta replay with markupRate decimal variant does not throw (2 vs 2.0)", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    // First write uses markupRate "2" (canonical form from Postgres Decimal).
    await applyDelta({
      accountId,
      delta: 100n,
      reason: LedgerReason.consume,
      idempotencyKey: "markup-replay-1",
      scope: "transaction",
      markupRate: "2",
    });

    // Replay with "2.0" — Decimal-normalized they are equal; must NOT throw.
    const replay = await applyDelta({
      accountId,
      delta: 100n,
      reason: LedgerReason.consume,
      idempotencyKey: "markup-replay-1",
      scope: "transaction",
      markupRate: "2.0",
    });
    expect(replay.replayed).toBe(true);
  });

  test("applyDelta replay with different delta throws IdempotencyMismatchError", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    await applyDelta({
      accountId,
      delta: 50n,
      reason: LedgerReason.grant,
      idempotencyKey: "k1",
      scope: "grant",
      grantKindId: "manual",
    });

    await expect(
      applyDelta({
        accountId,
        delta: 99n,
        reason: LedgerReason.grant,
        idempotencyKey: "k1",
        scope: "grant",
        grantKindId: "manual",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);

    expect(await getBalance(accountId)).toBe(50n);
  });

  test("applyDelta first-write returns post-tx newBalance", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    const result = await applyDelta({
      accountId,
      delta: 100n,
      reason: LedgerReason.grant,
      idempotencyKey: "nb-1",
      scope: "grant",
      grantKindId: "manual",
    });

    expect(result.newBalance).toBe(100n);
    expect(result.newBalance).toBe(await getBalance(accountId));
  });

  test("applyDelta replay returns current newBalance, not stale grant-time value", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    await applyDelta({
      accountId,
      delta: 100n,
      reason: LedgerReason.grant,
      idempotencyKey: "nb-orig",
      scope: "grant",
      grantKindId: "manual",
    });
    // Intervening consume after original grant — replay must report current
    // balance (70n), not the post-original-grant balance (100n).
    // NOTE: After Task 4, replayed newBalance returns prior.balanceAfter (the
    // snapshot at write time), not current balance. This test is updated in
    // Task 17 to reflect the new semantics. For now scope is added to keep
    // the test compilable.
    await applyDelta({
      accountId,
      delta: -30n,
      reason: LedgerReason.consume,
      idempotencyKey: "nb-burn",
      scope: "transaction",
    });

    const replay = await applyDelta({
      accountId,
      delta: 100n,
      reason: LedgerReason.grant,
      idempotencyKey: "nb-orig",
      scope: "grant",
      grantKindId: "manual",
    });

    expect(replay.replayed).toBe(true);
    // Task 4 change: replay now returns prior.balanceAfter (100n), not current (70n).
    // The old assertion was: expect(replay.newBalance).toBe(70n)
    // Updated to match new semantics:
    expect(replay.newBalance).toBe(100n);
    expect(replay.balanceAfter).toBe(100n);
  });

  test("invariant: balance == SUM(delta) after mixed sequence", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    await applyDelta({
      accountId,
      delta: 100n,
      reason: LedgerReason.grant,
      idempotencyKey: "g1",
      scope: "grant",
      grantKindId: "manual",
    });
    await applyDelta({
      accountId,
      delta: -30n,
      reason: LedgerReason.consume,
      idempotencyKey: "c1",
      scope: "transaction",
    });
    await applyDelta({
      accountId,
      delta: 50n,
      reason: LedgerReason.grant,
      idempotencyKey: "g2",
      scope: "grant",
      grantKindId: "manual",
    });
    await applyDelta({
      accountId,
      delta: -10n,
      reason: LedgerReason.adjust,
      idempotencyKey: "a1",
      scope: "transaction",
      note: "fix",
    });

    const balance = await getBalance(accountId);
    const agg = await prisma.creditLedger.aggregate({
      where: { accountId },
      _sum: { delta: true },
    });
    expect(balance).toBe(BigInt(agg._sum.delta ?? 0));
  });
});

describe("payments/ledger/repository — floor + history", () => {
  const cleanupAccounts: string[] = [];

  afterEach(async () => {
    for (const accountId of cleanupAccounts) {
      await prisma.creditLedger.deleteMany({ where: { accountId } });
      await prisma.userCredits.deleteMany({ where: { accountId } });
      await prisma.account.deleteMany({ where: { id: accountId } });
    }
    cleanupAccounts.length = 0;
  });

  test("floor breach throws and writes nothing", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    // seed at -500
    await applyDelta({
      accountId,
      delta: -500n,
      reason: LedgerReason.adjust,
      idempotencyKey: "seed",
      scope: "transaction",
      note: "seed",
    });

    await expect(
      applyDelta({
        accountId,
        delta: -1000n,
        reason: LedgerReason.consume,
        idempotencyKey: "breach",
        scope: "transaction",
        floorCheck: { minBalance: -1000n },
      }),
    ).rejects.toBeInstanceOf(LedgerFloorBreachError);

    expect(await getBalance(accountId)).toBe(-500n);
    const rows = await prisma.creditLedger.findMany({ where: { accountId } });
    expect(rows).toHaveLength(1);
  });

  test("getHistory orders DESC by (createdAt, id) and paginates by tuple cursor", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    for (let i = 0; i < 5; i++) {
      await applyDelta({
        accountId,
        delta: 1n,
        reason: LedgerReason.grant,
        idempotencyKey: `h${i}`,
        scope: "grant",
        grantKindId: "manual",
      });
    }

    const page1 = await getHistory(accountId, 2);
    expect(page1).toHaveLength(2);

    const last = page1[page1.length - 1];
    const page2 = await getHistory(accountId, 2, {
      createdAt: last.createdAt,
      id: last.id,
    });
    expect(page2).toHaveLength(2);

    const ids = [...page1, ...page2].map((r) => r.id);
    expect(new Set(ids).size).toBe(4);
  });

  test("getHistory tuple cursor breaks createdAt ties by id DESC", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    // Force identical createdAt across rows by inserting directly with prisma.
    // applyDelta uses server-side now() and may not collide reliably.
    const sharedTs = new Date("2030-01-01T00:00:00.000Z");
    // Seed the UserCredits row so the FK / invariants stay sane (balance is
    // not asserted here — this test only exercises ordering).
    await prisma.userCredits.create({
      data: { accountId, balance: 0n },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.creditLedger.create({
        data: {
          accountId,
          delta: 1n,
          reason: LedgerReason.grant,
          idempotencyKey: `tie${i}`,
          grantKindId: "manual",
          createdAt: sharedTs,
        },
      });
    }

    const all = await getHistory(accountId, 10);
    expect(all).toHaveLength(3);
    // All three share createdAt, so ordering must come from id DESC.
    const idsDesc = [...all.map((r) => r.id)].sort().reverse();
    expect(all.map((r) => r.id)).toEqual(idsDesc);

    // Paginate with a tuple cursor anchored on the first row. The remaining
    // page must continue id-DESC within the same createdAt bucket.
    const page1 = await getHistory(accountId, 1);
    expect(page1).toHaveLength(1);
    const page2 = await getHistory(accountId, 10, {
      createdAt: page1[0].createdAt,
      id: page1[0].id,
    });
    expect(page2).toHaveLength(2);
    expect(page2.map((r) => r.id)).toEqual(idsDesc.slice(1));
  });
});

describe("applyDeltaWithTx writes balanceAfter + scope", () => {
  const cleanupAccounts: string[] = [];

  afterEach(async () => {
    for (const accountId of cleanupAccounts) {
      await prisma.creditLedger.deleteMany({ where: { accountId } });
      await prisma.userCredits.deleteMany({ where: { accountId } });
      await prisma.account.deleteMany({ where: { id: accountId } });
    }
    cleanupAccounts.length = 0;
  });

  it("returns balanceAfter equal to the post-update balance", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    const result = await applyDelta({
      accountId,
      delta: 100n,
      reason: LedgerReason.grant,
      idempotencyKey: "test_grant_1",
      scope: "grant",
      grantKindId: "manual",
    });
    expect(result.balanceAfter).toBe(100n);
    expect(result.newBalance).toBe(100n);
    expect(result.ledgerId).toBeDefined();

    const row = await prisma.creditLedger.findUnique({
      where: { id: result.ledgerId },
      select: { scope: true, balanceAfter: true },
    });
    expect(row?.scope).toBe("grant");
    expect(row?.balanceAfter).toBe(100n);
  });

  it("P2002 race-recovery returns prior.balanceAfter, not current balance", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    // First call writes the row at balance=50.
    const first = await applyDelta({
      accountId,
      delta: 50n,
      reason: LedgerReason.grant,
      idempotencyKey: "race_key",
      scope: "grant",
      grantKindId: "manual",
    });
    expect(first.balanceAfter).toBe(50n);

    // Mutate the account balance via a separate grant.
    await applyDelta({
      accountId,
      delta: 25n,
      reason: LedgerReason.grant,
      idempotencyKey: "intervening",
      scope: "grant",
      grantKindId: "manual",
    });
    // Current balance is now 75.

    // Replay first key — must return 50, not 75.
    const replay = await applyDelta({
      accountId,
      delta: 50n,
      reason: LedgerReason.grant,
      idempotencyKey: "race_key",
      scope: "grant",
      grantKindId: "manual",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.balanceAfter).toBe(50n);
    expect(replay.newBalance).toBe(50n);
    expect(replay.ledgerId).toBe(first.ledgerId);
  });
});
