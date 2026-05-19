import { afterEach, describe, expect, test } from "bun:test";
import {
  IdempotencyMismatchError,
  InsufficientBalanceError,
} from "@/payments/errors";
import {
  adjust,
  consume,
  getBalance,
  grant,
  isAllowed,
} from "@/payments/index";
import { prisma } from "@/utils/prisma";

const seedAccount = async (): Promise<string> => {
  const acct = await prisma.account.create({ data: {} });
  return acct.id;
};

describe("payments/index — composed service", () => {
  const cleanupAccounts: string[] = [];

  afterEach(async () => {
    for (const accountId of cleanupAccounts) {
      await prisma.creditLedger.deleteMany({ where: { accountId } });
      await prisma.userCredits.deleteMany({ where: { accountId } });
      await prisma.account.deleteMany({ where: { id: accountId } });
    }
    cleanupAccounts.length = 0;
  });

  test("grant adds credits and records snapshot fields", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    const r = await grant({
      accountId,
      credits: 100,
      idempotencyKey: "g1",
      kind: "signup_bonus",
    });
    expect(r.granted).toBe(100);
    expect(r.replayed).toBe(false);
    expect(await getBalance(accountId)).toBe(100n);

    const rows = await prisma.creditLedger.findMany({ where: { accountId } });
    expect(rows[0].grantKindId).toBe("signup_bonus");
    expect(rows[0].reason).toBe("grant");
  });

  test("grant returns post-tx newBalance on first call", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    const r = await grant({
      accountId,
      credits: 100,
      idempotencyKey: "nb-grant-1",
      kind: "signup_bonus",
    });

    expect(r.newBalance).toBe(100n);
    expect(r.newBalance).toBe(await getBalance(accountId));
  });

  test("grant replay returns current newBalance, not stale grant-time value", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    await grant({
      accountId,
      credits: 100,
      idempotencyKey: "nb-grant-replay",
      kind: "signup_bonus",
    });
    // Simulate concurrent burn after grant — replay must report current
    // balance (70n), not the post-grant balance (100n).
    await consume({
      accountId,
      usdCostMicros: 15000n, // 15000 micros × markup 2 × 1000 cpd / 1e6 = 30 credits
      idempotencyKey: "nb-grant-burn",
      requestId: "req-burn",
    });

    const replay = await grant({
      accountId,
      credits: 100,
      idempotencyKey: "nb-grant-replay",
      kind: "signup_bonus",
    });

    expect(replay.replayed).toBe(true);
    expect(replay.newBalance).toBe(70n);
    expect(replay.newBalance).toBe(await getBalance(accountId));
  });

  test("grant rejects unknown kind", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);
    expect(
      grant({
        accountId,
        credits: 10,
        idempotencyKey: "x",
        // @ts-expect-error testing runtime behavior with invalid kind
        kind: "not_a_kind",
      }),
    ).rejects.toThrow(); // ZodError from schema parse
    expect(await getBalance(accountId)).toBe(0n);
  });

  test("consume converts USD to credits, deducts, snapshots pricing", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    await grant({
      accountId,
      credits: 100,
      idempotencyKey: "seed",
      kind: "signup_bonus",
    });
    const r = await consume({
      accountId,
      usdCostMicros: 2000n,
      idempotencyKey: "c1",
      requestId: "req-1",
      model: "claude-opus-4-7",
    });

    expect(r.spent).toBe(4);
    expect(r.replayed).toBe(false);
    expect(await getBalance(accountId)).toBe(96n);

    const row = await prisma.creditLedger.findFirst({
      where: { accountId, idempotencyKey: "c1" },
    });
    expect(row?.usdCostMicros).toBe(2000n);
    expect(row?.creditsPerDollar).toBe(1000n);
    expect(Number(row?.markupRate)).toBe(2);
    expect(row?.model).toBe("claude-opus-4-7");
    expect(row?.requestId).toBe("req-1");
  });

  test("consume past MIN_BALANCE throws InsufficientBalanceError, writes nothing", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    await adjust({
      accountId,
      delta: -996,
      idempotencyKey: "seed",
      note: "drop balance below safe",
    });
    expect(
      consume({
        accountId,
        usdCostMicros: 5000n,
        idempotencyKey: "breach",
        requestId: "req-1",
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(await getBalance(accountId)).toBe(-996n);
    const breachRow = await prisma.creditLedger.findFirst({
      where: { accountId, idempotencyKey: "breach" },
    });
    expect(breachRow).toBeNull();
  });

  test("adjust applies signed delta and records note", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    const r = await adjust({
      accountId,
      delta: 10,
      idempotencyKey: "a1",
      note: "support refund — call failed",
    });
    expect(r.applied).toBe(true);
    expect(r.replayed).toBe(false);
    expect(await getBalance(accountId)).toBe(10n);
    const row = await prisma.creditLedger.findFirst({
      where: { accountId, idempotencyKey: "a1" },
    });
    expect(row?.note).toBe("support refund — call failed");
    expect(row?.reason).toBe("adjust");
  });

  test("adjust negative delta respects MIN_BALANCE", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    expect(
      adjust({
        accountId,
        delta: -2000,
        idempotencyKey: "a1",
        note: "would breach floor",
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(await getBalance(accountId)).toBe(0n);
  });

  test("isAllowed reflects RESERVED_MAX_TURN_CREDITS", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    expect(await isAllowed(accountId)).toBe(false);
    await grant({
      accountId,
      credits: 1,
      idempotencyKey: "seed",
      kind: "signup_bonus",
    });
    expect(await isAllowed(accountId)).toBe(true);
  });
});

describe("payments/index — replay + concurrency", () => {
  const cleanupAccounts: string[] = [];

  afterEach(async () => {
    for (const accountId of cleanupAccounts) {
      await prisma.creditLedger.deleteMany({ where: { accountId } });
      await prisma.userCredits.deleteMany({ where: { accountId } });
      await prisma.account.deleteMany({ where: { id: accountId } });
    }
    cleanupAccounts.length = 0;
  });

  test("consume replay is idempotent", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    await grant({
      accountId,
      credits: 100,
      idempotencyKey: "seed",
      kind: "signup_bonus",
    });
    const first = await consume({
      accountId,
      usdCostMicros: 2000n,
      idempotencyKey: "c1",
      requestId: "req-1",
    }); // balance 96

    await grant({
      accountId,
      credits: 50,
      idempotencyKey: "g2",
      kind: "manual",
    }); // balance 146

    const replay = await consume({
      accountId,
      usdCostMicros: 2000n,
      idempotencyKey: "c1",
      requestId: "req-1",
    }); // same key

    expect(first.replayed).toBe(false);
    expect(replay.spent).toBe(first.spent);
    expect(replay.replayed).toBe(true);
    expect(await getBalance(accountId)).toBe(146n); // unchanged by replay

    const rows = await prisma.creditLedger.findMany({
      where: { accountId, idempotencyKey: "c1" },
    });
    expect(rows).toHaveLength(1);
  });

  test("consume replay with different model throws IdempotencyMismatchError", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);
    await grant({
      accountId,
      credits: 100,
      idempotencyKey: "seed",
      kind: "signup_bonus",
    });
    await consume({
      accountId,
      usdCostMicros: 2000n,
      idempotencyKey: "c1",
      requestId: "req-1",
      model: "claude-opus-4-7",
    });
    expect(
      consume({
        accountId,
        usdCostMicros: 2000n,
        idempotencyKey: "c1",
        requestId: "req-1",
        model: "claude-haiku-4-5",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
    expect(await getBalance(accountId)).toBe(96n);
  });

  test("consume replay with different requestId throws IdempotencyMismatchError", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);
    await grant({
      accountId,
      credits: 100,
      idempotencyKey: "seed",
      kind: "signup_bonus",
    });
    await consume({
      accountId,
      usdCostMicros: 2000n,
      idempotencyKey: "c1",
      requestId: "req-1",
    });
    expect(
      consume({
        accountId,
        usdCostMicros: 2000n,
        idempotencyKey: "c1",
        requestId: "req-2",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  test("grant replay with identical payload returns replayed:true, balance unchanged", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);
    const first = await grant({
      accountId,
      credits: 50,
      idempotencyKey: "g1",
      kind: "manual",
      note: "same",
    });
    const replay = await grant({
      accountId,
      credits: 50,
      idempotencyKey: "g1",
      kind: "manual",
      note: "same",
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.granted).toBe(first.granted);
    expect(await getBalance(accountId)).toBe(50n);
    const rows = await prisma.creditLedger.findMany({
      where: { accountId, idempotencyKey: "g1" },
    });
    expect(rows).toHaveLength(1);
  });

  test("adjust replay with identical payload returns replayed:true, balance unchanged", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);
    const first = await adjust({
      accountId,
      delta: 25,
      idempotencyKey: "a1",
      note: "same note",
    });
    const replay = await adjust({
      accountId,
      delta: 25,
      idempotencyKey: "a1",
      note: "same note",
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.applied).toBe(true);
    expect(await getBalance(accountId)).toBe(25n);
    const rows = await prisma.creditLedger.findMany({
      where: { accountId, idempotencyKey: "a1" },
    });
    expect(rows).toHaveLength(1);
  });

  test("grant replay with different note throws IdempotencyMismatchError", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);
    await grant({
      accountId,
      credits: 50,
      idempotencyKey: "g1",
      kind: "manual",
      note: "first reason",
    });
    expect(
      grant({
        accountId,
        credits: 50,
        idempotencyKey: "g1",
        kind: "manual",
        note: "different reason",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
    expect(await getBalance(accountId)).toBe(50n);
  });

  test("grant replay with different kind throws IdempotencyMismatchError", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);
    await grant({
      accountId,
      credits: 50,
      idempotencyKey: "g1",
      kind: "manual",
    });
    expect(
      grant({
        accountId,
        credits: 50,
        idempotencyKey: "g1",
        kind: "signup_bonus",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  test("adjust replay with different note throws IdempotencyMismatchError", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);
    await adjust({
      accountId,
      delta: 25,
      idempotencyKey: "a1",
      note: "original note",
    });
    expect(
      adjust({
        accountId,
        delta: 25,
        idempotencyKey: "a1",
        note: "tampered note",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  test("grant replay succeeds even when GrantKind is deactivated after original grant", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    // First grant: active kind.
    const first = await grant({
      accountId,
      credits: 100,
      idempotencyKey: "g-deactivated-replay",
      kind: "signup_bonus",
    });
    expect(first.replayed).toBe(false);

    // Deactivate the kind.
    await prisma.grantKind.update({
      where: { id: "signup_bonus" },
      data: { active: false },
    });

    try {
      // Replay with same idempotency key must NOT throw GrantKindNotFoundError.
      const replay = await grant({
        accountId,
        credits: 100,
        idempotencyKey: "g-deactivated-replay",
        kind: "signup_bonus",
      });
      expect(replay.replayed).toBe(true);
      expect(replay.granted).toBe(100);
      // Balance must remain 100 — no double-credit.
      expect(await getBalance(accountId)).toBe(100n);
    } finally {
      // Restore the kind so other tests are not affected.
      await prisma.grantKind.update({
        where: { id: "signup_bonus" },
        data: { active: true },
      });
    }
  });

  test("concurrent consumes on same account serialize correctly (no lost updates)", async () => {
    const accountId = await seedAccount();
    cleanupAccounts.push(accountId);

    await grant({
      accountId,
      credits: 1000,
      idempotencyKey: "seed",
      kind: "signup_bonus",
    });

    const calls = Array.from({ length: 10 }, (_, i) =>
      consume({
        accountId,
        usdCostMicros: 2000n,
        idempotencyKey: `r${i}`,
        requestId: `req-${i}`,
      }),
    );
    const results = await Promise.all(calls);

    expect(results).toHaveLength(10);
    for (const r of results) expect(r.spent).toBe(4);

    expect(await getBalance(accountId)).toBe(960n); // 1000 - 10×4

    const rows = await prisma.creditLedger.findMany({
      where: { accountId, reason: "consume" },
    });
    expect(rows).toHaveLength(10);
  });
});
