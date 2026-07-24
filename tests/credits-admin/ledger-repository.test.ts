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

const addKinded = async (
  accountId: string,
  delta: bigint,
  createdAt: Date,
  reason: "consume" | "grant" | "adjust",
  grantKindId: string | null,
) => {
  await prisma.creditLedger.create({
    data: {
      accountId,
      delta,
      reason,
      grantKindId,
      idempotencyKey: `lrk_${accountId}_${createdAt.getTime()}_${delta}`,
      createdAt,
    },
  });
};

const kindsOf = (rows: { grantKindId: string | null }[]) =>
  new Set(rows.map((r) => r.grantKindId));

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

describe("listLedgerPageByAccount — filter", () => {
  const tracker2: string[] = [];
  afterEach(async () => {
    await cleanupAdminAccounts(tracker2);
    tracker2.length = 0;
  });

  // Seed one row per movement class, each on its own UTC day for deterministic order.
  const seedMix = async (a: string) => {
    await addKinded(
      a,
      100n,
      new Date("2026-07-10T12:00:00Z"),
      "grant",
      "sub_grant",
    );
    await addKinded(
      a,
      -40n,
      new Date("2026-07-11T12:00:00Z"),
      "adjust",
      "sub_forfeit",
    );
    await addKinded(
      a,
      500n,
      new Date("2026-07-12T12:00:00Z"),
      "grant",
      "manual",
    );
    await addKinded(a, -7n, new Date("2026-07-13T12:00:00Z"), "adjust", null);
    await addKinded(a, -3n, new Date("2026-07-14T12:00:00Z"), "consume", null);
    await addKinded(
      a,
      20n,
      new Date("2026-07-15T12:00:00Z"),
      "grant",
      "daily_refill",
    );
  };

  it("kind=subscription returns only sub_grant + sub_forfeit", async () => {
    const a = await seedAccount();
    tracker2.push(a);
    await seedMix(a);
    const { rows } = await listLedgerPageByAccount({
      accountId: a,
      limit: 50,
      filter: { kind: "subscription" },
    });
    expect(rows).toHaveLength(2);
    expect(kindsOf(rows)).toEqual(new Set(["sub_grant", "sub_forfeit"]));
  });

  it("kind=sub_forfeit isolates just forfeits", async () => {
    const a = await seedAccount();
    tracker2.push(a);
    await seedMix(a);
    const { rows } = await listLedgerPageByAccount({
      accountId: a,
      limit: 50,
      filter: { kind: "sub_forfeit" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].grantKindId).toBe("sub_forfeit");
  });

  it("reason=adjust surfaces admin-adjust (null kind) AND sub_forfeit", async () => {
    const a = await seedAccount();
    tracker2.push(a);
    await seedMix(a);
    const { rows } = await listLedgerPageByAccount({
      accountId: a,
      limit: 50,
      filter: { reason: "adjust" },
    });
    expect(rows).toHaveLength(2);
    expect(kindsOf(rows)).toEqual(new Set(["sub_forfeit", null]));
  });

  it("from-only excludes rows before the from UTC day", async () => {
    const a = await seedAccount();
    tracker2.push(a);
    await seedMix(a);
    const { rows } = await listLedgerPageByAccount({
      accountId: a,
      limit: 50,
      filter: { from: new Date("2026-07-13") },
    });
    // 07-13, 07-14, 07-15 kept; 07-10..07-12 dropped.
    expect(rows).toHaveLength(3);
  });

  it("to-only includes the whole to UTC day and excludes after", async () => {
    const a = await seedAccount();
    tracker2.push(a);
    await addKinded(a, 1n, new Date("2026-07-17T23:59:00Z"), "grant", "manual");
    await addKinded(a, 2n, new Date("2026-07-18T00:00:00Z"), "grant", "manual");
    const { rows } = await listLedgerPageByAccount({
      accountId: a,
      limit: 50,
      filter: { to: new Date("2026-07-17") },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].delta).toBe(1n);
  });

  it("combines kind + reason + date (AND)", async () => {
    const a = await seedAccount();
    tracker2.push(a);
    await seedMix(a);
    const { rows } = await listLedgerPageByAccount({
      accountId: a,
      limit: 50,
      filter: {
        kind: "subscription",
        reason: "grant",
        from: new Date("2026-07-01"),
        to: new Date("2026-07-31"),
      },
    });
    // Only sub_grant (reason=grant); sub_forfeit is reason=adjust so excluded.
    expect(rows).toHaveLength(1);
    expect(rows[0].grantKindId).toBe("sub_grant");
  });

  it("keyset page 2 preserves the filter — no off-filter rows leak", async () => {
    const a = await seedAccount();
    tracker2.push(a);
    // 3 sub_grant rows (target) interleaved with 3 manual rows (must never appear).
    await addKinded(
      a,
      1n,
      new Date("2026-07-01T00:00:00Z"),
      "grant",
      "sub_grant",
    );
    await addKinded(a, 9n, new Date("2026-07-02T00:00:00Z"), "grant", "manual");
    await addKinded(
      a,
      2n,
      new Date("2026-07-03T00:00:00Z"),
      "grant",
      "sub_grant",
    );
    await addKinded(a, 9n, new Date("2026-07-04T00:00:00Z"), "grant", "manual");
    await addKinded(
      a,
      3n,
      new Date("2026-07-05T00:00:00Z"),
      "grant",
      "sub_grant",
    );
    await addKinded(a, 9n, new Date("2026-07-06T00:00:00Z"), "grant", "manual");

    const p1 = await listLedgerPageByAccount({
      accountId: a,
      limit: 2,
      filter: { kind: "sub_grant" },
    });
    expect(p1.rows).toHaveLength(2);
    expect(kindsOf(p1.rows)).toEqual(new Set(["sub_grant"]));
    expect(p1.nextCursor).toBeTruthy();

    const cursor = decodeAuditCursor(p1.nextCursor as string);
    const p2 = await listLedgerPageByAccount({
      accountId: a,
      limit: 2,
      cursor,
      filter: { kind: "sub_grant" },
    });
    expect(p2.rows).toHaveLength(1);
    expect(kindsOf(p2.rows)).toEqual(new Set(["sub_grant"]));
    expect(p2.nextCursor).toBeNull();
  });
});
