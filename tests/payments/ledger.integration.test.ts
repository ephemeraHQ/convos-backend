import { LedgerReason } from "@prisma/client";
import { afterEach, describe, expect, test } from "bun:test";
import { IdempotencyMismatchError } from "@/payments/errors";
import {
  applyDelta,
  getBalance,
  getHistory,
  LedgerFloorBreachError,
} from "@/payments/ledger/repository";
import { prisma } from "@/utils/prisma";

const inbox = (suffix: string) =>
  `inbox_test_${suffix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describe("payments/ledger/repository", () => {
  const cleanupKeys: { inboxId: string }[] = [];

  afterEach(async () => {
    for (const c of cleanupKeys) {
      await prisma.creditLedger.deleteMany({ where: { inboxId: c.inboxId } });
      await prisma.userCredits.deleteMany({ where: { inboxId: c.inboxId } });
    }
    cleanupKeys.length = 0;
  });

  test("getBalance returns 0n for unknown inboxId", async () => {
    const id = inbox("unknown");
    expect(await getBalance(id)).toBe(0n);
  });

  test("applyDelta first-write creates UserCredits row + ledger row", async () => {
    const id = inbox("firstwrite");
    cleanupKeys.push({ inboxId: id });

    const result = await applyDelta({
      inboxId: id,
      delta: 100n,
      reason: LedgerReason.grant,
      idempotencyKey: "k1",
      grantKindId: "manual",
    });

    expect(result.replayed).toBe(false);

    const balance = await getBalance(id);
    expect(balance).toBe(100n);

    const rows = await prisma.creditLedger.findMany({ where: { inboxId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].delta).toBe(100n);
    expect(rows[0].idempotencyKey).toBe("k1");
  });

  test("applyDelta replay returns ledgerId, no double mutation", async () => {
    const id = inbox("replay");
    cleanupKeys.push({ inboxId: id });

    await applyDelta({
      inboxId: id,
      delta: 50n,
      reason: LedgerReason.grant,
      idempotencyKey: "k1",
      grantKindId: "manual",
    });
    // intervening mutation to prove replay does not double-apply
    await applyDelta({
      inboxId: id,
      delta: 25n,
      reason: LedgerReason.grant,
      idempotencyKey: "k2",
      grantKindId: "manual",
    });
    const replay = await applyDelta({
      inboxId: id,
      delta: 50n,
      reason: LedgerReason.grant,
      idempotencyKey: "k1",
      grantKindId: "manual",
    });

    expect(replay.replayed).toBe(true);
    expect(await getBalance(id)).toBe(75n); // current is unchanged by replay
    const rows = await prisma.creditLedger.findMany({ where: { inboxId: id } });
    expect(rows).toHaveLength(2);
  });

  test("applyDelta replay with different delta throws IdempotencyMismatchError", async () => {
    const id = inbox("mismatch");
    cleanupKeys.push({ inboxId: id });

    await applyDelta({
      inboxId: id,
      delta: 50n,
      reason: LedgerReason.grant,
      idempotencyKey: "k1",
      grantKindId: "manual",
    });

    expect(
      applyDelta({
        inboxId: id,
        delta: 99n,
        reason: LedgerReason.grant,
        idempotencyKey: "k1",
        grantKindId: "manual",
      }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);

    expect(await getBalance(id)).toBe(50n);
  });

  test("invariant: balance == SUM(delta) after mixed sequence", async () => {
    const id = inbox("invariant");
    cleanupKeys.push({ inboxId: id });

    await applyDelta({
      inboxId: id,
      delta: 100n,
      reason: LedgerReason.grant,
      idempotencyKey: "g1",
      grantKindId: "manual",
    });
    await applyDelta({
      inboxId: id,
      delta: -30n,
      reason: LedgerReason.consume,
      idempotencyKey: "c1",
    });
    await applyDelta({
      inboxId: id,
      delta: 50n,
      reason: LedgerReason.grant,
      idempotencyKey: "g2",
      grantKindId: "manual",
    });
    await applyDelta({
      inboxId: id,
      delta: -10n,
      reason: LedgerReason.adjust,
      idempotencyKey: "a1",
      note: "fix",
    });

    const balance = await getBalance(id);
    const agg = await prisma.creditLedger.aggregate({
      where: { inboxId: id },
      _sum: { delta: true },
    });
    expect(balance).toBe(BigInt(agg._sum.delta ?? 0));
  });
});

describe("payments/ledger/repository — floor + history", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const id of cleanup) {
      await prisma.creditLedger.deleteMany({ where: { inboxId: id } });
      await prisma.userCredits.deleteMany({ where: { inboxId: id } });
    }
    cleanup.length = 0;
  });

  test("floor breach throws and writes nothing", async () => {
    const id = inbox("floor");
    cleanup.push(id);

    // seed at -500
    await applyDelta({
      inboxId: id,
      delta: -500n,
      reason: LedgerReason.adjust,
      idempotencyKey: "seed",
      note: "seed",
    });

    expect(
      applyDelta({
        inboxId: id,
        delta: -1000n,
        reason: LedgerReason.consume,
        idempotencyKey: "breach",
        floorCheck: { minBalance: -1000n },
      }),
    ).rejects.toBeInstanceOf(LedgerFloorBreachError);

    expect(await getBalance(id)).toBe(-500n);
    const rows = await prisma.creditLedger.findMany({ where: { inboxId: id } });
    expect(rows).toHaveLength(1);
  });

  test("getHistory orders DESC by (createdAt, id) and paginates by tuple cursor", async () => {
    const id = inbox("history");
    cleanup.push(id);

    for (let i = 0; i < 5; i++) {
      await applyDelta({
        inboxId: id,
        delta: 1n,
        reason: LedgerReason.grant,
        idempotencyKey: `h${i}`,
        grantKindId: "manual",
      });
    }

    const page1 = await getHistory(id, 2);
    expect(page1).toHaveLength(2);

    const last = page1[page1.length - 1];
    const page2 = await getHistory(id, 2, {
      createdAt: last.createdAt,
      id: last.id,
    });
    expect(page2).toHaveLength(2);

    const ids = [...page1, ...page2].map((r) => r.id);
    expect(new Set(ids).size).toBe(4);
  });

  test("getHistory tuple cursor breaks createdAt ties by id DESC", async () => {
    const id = inbox("tiecursor");
    cleanup.push(id);

    // Force identical createdAt across rows by inserting directly with prisma.
    // applyDelta uses server-side now() and may not collide reliably.
    const sharedTs = new Date("2030-01-01T00:00:00.000Z");
    // Seed the UserCredits row so the FK / invariants stay sane (balance is
    // not asserted here — this test only exercises ordering).
    await prisma.userCredits.create({
      data: { inboxId: id, balance: 0n },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.creditLedger.create({
        data: {
          inboxId: id,
          delta: 1n,
          reason: LedgerReason.grant,
          idempotencyKey: `tie${i}`,
          grantKindId: "manual",
          createdAt: sharedTs,
        },
      });
    }

    const all = await getHistory(id, 10);
    expect(all).toHaveLength(3);
    // All three share createdAt, so ordering must come from id DESC.
    const idsDesc = [...all.map((r) => r.id)].sort().reverse();
    expect(all.map((r) => r.id)).toEqual(idsDesc);

    // Paginate with a tuple cursor anchored on the first row. The remaining
    // page must continue id-DESC within the same createdAt bucket.
    const page1 = await getHistory(id, 1);
    expect(page1).toHaveLength(1);
    const page2 = await getHistory(id, 10, {
      createdAt: page1[0].createdAt,
      id: page1[0].id,
    });
    expect(page2).toHaveLength(2);
    expect(page2.map((r) => r.id)).toEqual(idsDesc.slice(1));
  });
});
