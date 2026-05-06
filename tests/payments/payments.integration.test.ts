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

const inbox = (suffix: string) =>
  `inbox_pay_${suffix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const wipe = async (id: string) => {
  await prisma.creditLedger.deleteMany({ where: { inboxId: id } });
  await prisma.userCredits.deleteMany({ where: { inboxId: id } });
};

describe("payments/index — composed service", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const id of cleanup) await wipe(id);
    cleanup.length = 0;
  });

  test("grant adds credits and records snapshot fields", async () => {
    const id = inbox("grant");
    cleanup.push(id);

    const r = await grant({
      inboxId: id,
      credits: 100,
      idempotencyKey: "g1",
      kind: "signup_bonus",
    });
    expect(r.granted).toBe(100);
    expect(r.replayed).toBe(false);
    expect(await getBalance(id)).toBe(100n);

    const rows = await prisma.creditLedger.findMany({ where: { inboxId: id } });
    expect(rows[0].grantKindId).toBe("signup_bonus");
    expect(rows[0].reason).toBe("grant");
  });

  test("grant rejects unknown kind", async () => {
    const id = inbox("grantbad");
    cleanup.push(id);
    expect(
      grant({
        inboxId: id,
        credits: 10,
        idempotencyKey: "x",
        // @ts-expect-error testing runtime behavior with invalid kind
        kind: "not_a_kind",
      }),
    ).rejects.toThrow(); // ZodError from schema parse
    expect(await getBalance(id)).toBe(0n);
  });

  test("consume converts USD to credits, deducts, snapshots pricing", async () => {
    const id = inbox("consume");
    cleanup.push(id);

    await grant({
      inboxId: id,
      credits: 100,
      idempotencyKey: "seed",
      kind: "signup_bonus",
    });
    const r = await consume({
      inboxId: id,
      usdCostMicros: 2000n,
      idempotencyKey: "c1",
      requestId: "req-1",
      model: "claude-opus-4-7",
    });

    expect(r.spent).toBe(4);
    expect(r.replayed).toBe(false);
    expect(await getBalance(id)).toBe(96n);

    const row = await prisma.creditLedger.findFirst({
      where: { inboxId: id, idempotencyKey: "c1" },
    });
    expect(row?.usdCostMicros).toBe(2000n);
    expect(row?.creditsPerDollar).toBe(1000n);
    expect(Number(row?.markupRate)).toBe(2);
    expect(row?.model).toBe("claude-opus-4-7");
    expect(row?.requestId).toBe("req-1");
  });

  test("consume past MIN_BALANCE throws InsufficientBalanceError, writes nothing", async () => {
    const id = inbox("floor");
    cleanup.push(id);

    await adjust({
      inboxId: id,
      delta: -996,
      idempotencyKey: "seed",
      note: "drop balance below safe",
    });
    expect(
      consume({
        inboxId: id,
        usdCostMicros: 5000n,
        idempotencyKey: "breach",
        requestId: "req-1",
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(await getBalance(id)).toBe(-996n);
    const breachRow = await prisma.creditLedger.findFirst({
      where: { inboxId: id, idempotencyKey: "breach" },
    });
    expect(breachRow).toBeNull();
  });

  test("adjust applies signed delta and records note", async () => {
    const id = inbox("adjust");
    cleanup.push(id);

    const r = await adjust({
      inboxId: id,
      delta: 10,
      idempotencyKey: "a1",
      note: "support refund — call failed",
    });
    expect(r.applied).toBe(true);
    expect(r.replayed).toBe(false);
    expect(await getBalance(id)).toBe(10n);
    const row = await prisma.creditLedger.findFirst({
      where: { inboxId: id, idempotencyKey: "a1" },
    });
    expect(row?.note).toBe("support refund — call failed");
    expect(row?.reason).toBe("adjust");
  });

  test("adjust negative delta respects MIN_BALANCE", async () => {
    const id = inbox("adjustfloor");
    cleanup.push(id);

    expect(
      adjust({
        inboxId: id,
        delta: -2000,
        idempotencyKey: "a1",
        note: "would breach floor",
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(await getBalance(id)).toBe(0n);
  });

  test("isAllowed reflects RESERVED_MAX_TURN_CREDITS", async () => {
    const id = inbox("allowed");
    cleanup.push(id);

    expect(await isAllowed(id)).toBe(false);
    await grant({
      inboxId: id,
      credits: 1,
      idempotencyKey: "seed",
      kind: "signup_bonus",
    });
    expect(await isAllowed(id)).toBe(true);
  });
});

describe("payments/index — replay + concurrency", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const id of cleanup) await wipe(id);
    cleanup.length = 0;
  });

  test("consume replay is idempotent", async () => {
    const id = inbox("replay");
    cleanup.push(id);

    await grant({
      inboxId: id,
      credits: 100,
      idempotencyKey: "seed",
      kind: "signup_bonus",
    });
    const first = await consume({
      inboxId: id,
      usdCostMicros: 2000n,
      idempotencyKey: "c1",
      requestId: "req-1",
    }); // balance 96

    await grant({
      inboxId: id,
      credits: 50,
      idempotencyKey: "g2",
      kind: "manual",
    }); // balance 146

    const replay = await consume({
      inboxId: id,
      usdCostMicros: 2000n,
      idempotencyKey: "c1",
      requestId: "req-1",
    }); // same key

    expect(first.replayed).toBe(false);
    expect(replay.spent).toBe(first.spent);
    expect(replay.replayed).toBe(true);
    expect(await getBalance(id)).toBe(146n); // unchanged by replay

    const rows = await prisma.creditLedger.findMany({
      where: { inboxId: id, idempotencyKey: "c1" },
    });
    expect(rows).toHaveLength(1);
  });

  test("consume replay with different model throws IdempotencyMismatchError", async () => {
    const id = inbox("replay-model");
    cleanup.push(id);
    await grant({
      inboxId: id,
      credits: 100,
      idempotencyKey: "seed",
      kind: "signup_bonus",
    });
    await consume({
      inboxId: id,
      usdCostMicros: 2000n,
      idempotencyKey: "c1",
      requestId: "req-1",
      model: "claude-opus-4-7",
    });
    expect(
      consume({
        inboxId: id,
        usdCostMicros: 2000n,
        idempotencyKey: "c1",
        requestId: "req-1",
        model: "claude-haiku-4-5",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
    expect(await getBalance(id)).toBe(96n);
  });

  test("consume replay with different requestId throws IdempotencyMismatchError", async () => {
    const id = inbox("replay-req");
    cleanup.push(id);
    await grant({
      inboxId: id,
      credits: 100,
      idempotencyKey: "seed",
      kind: "signup_bonus",
    });
    await consume({
      inboxId: id,
      usdCostMicros: 2000n,
      idempotencyKey: "c1",
      requestId: "req-1",
    });
    expect(
      consume({
        inboxId: id,
        usdCostMicros: 2000n,
        idempotencyKey: "c1",
        requestId: "req-2",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  test("grant replay with identical payload returns replayed:true, balance unchanged", async () => {
    const id = inbox("replay-grant-ok");
    cleanup.push(id);
    const first = await grant({
      inboxId: id,
      credits: 50,
      idempotencyKey: "g1",
      kind: "manual",
      note: "same",
    });
    const replay = await grant({
      inboxId: id,
      credits: 50,
      idempotencyKey: "g1",
      kind: "manual",
      note: "same",
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.granted).toBe(first.granted);
    expect(await getBalance(id)).toBe(50n);
    const rows = await prisma.creditLedger.findMany({
      where: { inboxId: id, idempotencyKey: "g1" },
    });
    expect(rows).toHaveLength(1);
  });

  test("adjust replay with identical payload returns replayed:true, balance unchanged", async () => {
    const id = inbox("replay-adjust-ok");
    cleanup.push(id);
    const first = await adjust({
      inboxId: id,
      delta: 25,
      idempotencyKey: "a1",
      note: "same note",
    });
    const replay = await adjust({
      inboxId: id,
      delta: 25,
      idempotencyKey: "a1",
      note: "same note",
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.applied).toBe(true);
    expect(await getBalance(id)).toBe(25n);
    const rows = await prisma.creditLedger.findMany({
      where: { inboxId: id, idempotencyKey: "a1" },
    });
    expect(rows).toHaveLength(1);
  });

  test("grant replay with different note throws IdempotencyMismatchError", async () => {
    const id = inbox("replay-grant-note");
    cleanup.push(id);
    await grant({
      inboxId: id,
      credits: 50,
      idempotencyKey: "g1",
      kind: "manual",
      note: "first reason",
    });
    expect(
      grant({
        inboxId: id,
        credits: 50,
        idempotencyKey: "g1",
        kind: "manual",
        note: "different reason",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
    expect(await getBalance(id)).toBe(50n);
  });

  test("grant replay with different kind throws IdempotencyMismatchError", async () => {
    const id = inbox("replay-grant-kind");
    cleanup.push(id);
    await grant({
      inboxId: id,
      credits: 50,
      idempotencyKey: "g1",
      kind: "manual",
    });
    expect(
      grant({
        inboxId: id,
        credits: 50,
        idempotencyKey: "g1",
        kind: "signup_bonus",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  test("adjust replay with different note throws IdempotencyMismatchError", async () => {
    const id = inbox("replay-adjust-note");
    cleanup.push(id);
    await adjust({
      inboxId: id,
      delta: 25,
      idempotencyKey: "a1",
      note: "original note",
    });
    expect(
      adjust({
        inboxId: id,
        delta: 25,
        idempotencyKey: "a1",
        note: "tampered note",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  test("concurrent consumes on same inbox serialize correctly (no lost updates)", async () => {
    const id = inbox("race");
    cleanup.push(id);

    await grant({
      inboxId: id,
      credits: 1000,
      idempotencyKey: "seed",
      kind: "signup_bonus",
    });

    const calls = Array.from({ length: 10 }, (_, i) =>
      consume({
        inboxId: id,
        usdCostMicros: 2000n,
        idempotencyKey: `r${i}`,
        requestId: `req-${i}`,
      }),
    );
    const results = await Promise.all(calls);

    expect(results).toHaveLength(10);
    for (const r of results) expect(r.spent).toBe(4);

    expect(await getBalance(id)).toBe(960n); // 1000 - 10×4

    const rows = await prisma.creditLedger.findMany({
      where: { inboxId: id, reason: "consume" },
    });
    expect(rows).toHaveLength(10);
  });
});
