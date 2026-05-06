import { afterEach, describe, expect, test } from "bun:test";
import {
  GrantKindNotFoundError,
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

    const r = await grant(id, 100, "g1", "signup_bonus");
    expect(r.granted).toBe(100);
    expect(await getBalance(id)).toBe(100n);

    const rows = await prisma.creditLedger.findMany({ where: { inboxId: id } });
    expect(rows[0].grantKindId).toBe("signup_bonus");
    expect(rows[0].reason).toBe("grant");
  });

  test("grant rejects unknown kind", async () => {
    const id = inbox("grantbad");
    cleanup.push(id);
    // @ts-expect-error testing runtime behavior with invalid kind
    await expect(grant(id, 10, "x", "not_a_kind")).rejects.toBeInstanceOf(
      GrantKindNotFoundError,
    );
    expect(await getBalance(id)).toBe(0n);
  });

  test("consume converts USD to credits, deducts, snapshots pricing", async () => {
    const id = inbox("consume");
    cleanup.push(id);

    await grant(id, 100, "seed", "signup_bonus");
    const r = await consume(id, 2000n, "c1", "req-1", {
      model: "claude-opus-4-7",
    });

    expect(r.spent).toBe(4);
    expect(await getBalance(id)).toBe(96n);

    const row = await prisma.creditLedger.findFirst({
      where: { inboxId: id, idempotencyKey: "c1" },
    });
    expect(row?.usdCostMicros).toBe(2000n);
    expect(row?.creditsPerDollar).toBe(1000);
    expect(Number(row?.markupRate)).toBe(2);
    expect(row?.model).toBe("claude-opus-4-7");
    expect(row?.requestId).toBe("req-1");
  });

  test("consume past MIN_BALANCE throws InsufficientBalanceError, writes nothing", async () => {
    const id = inbox("floor");
    cleanup.push(id);

    await adjust(id, -996, "seed", "drop balance below safe");
    await expect(consume(id, 5000n, "breach", "req-1")).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
    expect(await getBalance(id)).toBe(-996n);
    const breachRow = await prisma.creditLedger.findFirst({
      where: { inboxId: id, idempotencyKey: "breach" },
    });
    expect(breachRow).toBeNull();
  });

  test("adjust applies signed delta and records note", async () => {
    const id = inbox("adjust");
    cleanup.push(id);

    const r = await adjust(id, 10, "a1", "support refund — call failed");
    expect(r.applied).toBe(true);
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

    await expect(
      adjust(id, -2000, "a1", "would breach floor"),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(await getBalance(id)).toBe(0n);
  });

  test("isAllowed reflects RESERVED_MAX_TURN_CREDITS", async () => {
    const id = inbox("allowed");
    cleanup.push(id);

    expect(await isAllowed(id)).toBe(false);
    await grant(id, 1, "seed", "signup_bonus");
    expect(await isAllowed(id)).toBe(true);
  });
});

describe("payments/index — replay + concurrency", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const id of cleanup) await wipe(id);
    cleanup.length = 0;
  });

  test("consume replay returns historical balanceAfter, not current", async () => {
    const id = inbox("replay");
    cleanup.push(id);

    await grant(id, 100, "seed", "signup_bonus");
    const first = await consume(id, 2000n, "c1", "req-1"); // balance 96

    await grant(id, 50, "g2", "manual"); // balance 146

    const replay = await consume(id, 2000n, "c1", "req-1"); // same key

    expect(replay.spent).toBe(first.spent);
    expect(await getBalance(id)).toBe(146n); // unchanged by replay

    const rows = await prisma.creditLedger.findMany({
      where: { inboxId: id, idempotencyKey: "c1" },
    });
    expect(rows).toHaveLength(1);
  });

  test("concurrent consumes on same inbox serialize correctly (no lost updates)", async () => {
    const id = inbox("race");
    cleanup.push(id);

    await grant(id, 1000, "seed", "signup_bonus");

    const calls = Array.from({ length: 10 }, (_, i) =>
      consume(id, 2000n, `r${i}`, `req-${i}`),
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
