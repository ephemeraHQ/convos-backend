import { afterEach, describe, expect, it } from "vitest";
import { decodeAuditCursor } from "@/api/v2/credits-admin/audit-repository";
import {
  listLedgerPageByAccount,
  serializeLedger,
} from "@/api/v2/credits-admin/ledger-repository";
import { prisma } from "@/utils/prisma";
import { cleanupAdminAccounts, seedAccount } from "./helpers";

const addLedger = async (accountId: string, delta: bigint, createdAt: Date) => {
  await prisma.creditLedger.create({
    data: {
      accountId,
      delta,
      reason: "grant",
      grantKindId: null,
      idempotencyKey: `lr_${accountId}_${createdAt.getTime()}_${delta}`,
      createdAt,
    },
  });
};

describe("ledger-repository", () => {
  const tracker: string[] = [];
  afterEach(async () => {
    await cleanupAdminAccounts(tracker);
    tracker.length = 0;
  });

  it("pages newest-first with a nextCursor, then exhausts", async () => {
    const a = await seedAccount();
    tracker.push(a);
    const base = Date.now() - 100 * 86400000;
    for (let i = 0; i < 3; i++) {
      await addLedger(a, BigInt(i + 1), new Date(base + i * 86400000));
    }
    const p1 = await listLedgerPageByAccount({ accountId: a, limit: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.rows[0].delta).toBe(3n);
    expect(p1.nextCursor).toBeTruthy();

    const cursor = decodeAuditCursor(p1.nextCursor as string);
    expect(cursor).not.toBeNull();
    const p2 = await listLedgerPageByAccount({
      accountId: a,
      limit: 2,
      cursor,
    });
    expect(p2.rows).toHaveLength(1);
    expect(p2.rows[0].delta).toBe(1n);
    expect(p2.nextCursor).toBeNull();
  });

  it("serializeLedger stringifies bigints and ISO-dates", async () => {
    const a = await seedAccount();
    tracker.push(a);
    await addLedger(a, 42n, new Date(Date.now() - 86400000));
    const { rows } = await listLedgerPageByAccount({ accountId: a, limit: 10 });
    const s = serializeLedger(rows[0]);
    expect(s.delta).toBe("42");
    expect(typeof s.createdAt).toBe("string");
    expect(s.createdAt).toMatch(/T.*Z$/);
  });
});
