import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeAuditCursor,
  encodeAuditCursor,
  listAdminAuditByAccount,
  listRecentAdminAudit,
  writeAdminAudit,
} from "@/api/v2/credits-admin/audit-repository";
import { prisma } from "@/utils/prisma";
import { cleanupAdminAccounts, seedAccount } from "./helpers";

describe("AdminAudit repository", () => {
  const accounts: string[] = [];
  afterEach(async () => {
    for (const accountId of accounts) {
      await prisma.adminAudit.deleteMany({ where: { accountId } });
      await prisma.account.deleteMany({ where: { id: accountId } });
    }
    accounts.length = 0;
  });

  it("writes a row and lists it back, newest first", async () => {
    // writeAdminAudit is fenced by requireLiveAccount: the account row must
    // exist for the write to land.
    const { id: accountId } = await prisma.account.create({ data: {} });
    accounts.push(accountId);

    await writeAdminAudit({
      accountId,
      actorEmail: "admin@convos.test",
      action: "grant",
      deltaCredits: 500_000n,
      reason: "first",
      idempotencyKey: `admin_grant_${randomUUID()}`,
    });
    await writeAdminAudit({
      accountId,
      actorEmail: "admin@convos.test",
      action: "adjust",
      deltaCredits: -100n,
      reason: "second",
      idempotencyKey: `admin_adjust_${randomUUID()}`,
    });

    const rows = await listAdminAuditByAccount(accountId);
    expect(rows).toHaveLength(2);
    expect(rows[0].createdAt.getTime()).toBeGreaterThanOrEqual(
      rows[1].createdAt.getTime(),
    );
    const first = rows.find((r) => r.reason === "first");
    const second = rows.find((r) => r.reason === "second");
    expect(first?.action).toBe("grant");
    expect(second?.action).toBe("adjust");
    expect(second?.deltaCredits).toBe(-100n);
  });
});

describe("listRecentAdminAudit (global, keyset)", () => {
  const tracker: string[] = [];
  afterEach(async () => {
    await cleanupAdminAccounts(tracker);
    tracker.length = 0;
  });

  const seedAudit = async (
    accountId: string,
    action: "grant" | "adjust",
    delta: bigint,
    key: string,
  ) => {
    await writeAdminAudit({
      accountId,
      actorEmail: "admin@test",
      action,
      deltaCredits: delta,
      reason: "seed",
      idempotencyKey: key,
    });
  };

  it("returns newest-first and paginates with the cursor", async () => {
    const a = await seedAccount();
    tracker.push(a);
    for (let i = 0; i < 5; i++)
      await seedAudit(a, "grant", BigInt(i + 1), `k_${i}`);

    const page1 = await listRecentAdminAudit({ limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.rows.map((r) => r.idempotencyKey)).toEqual(["k_4", "k_3"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listRecentAdminAudit({
      limit: 2,
      cursor: decodeAuditCursor(page1.nextCursor as string),
    });
    expect(page2.rows).toHaveLength(2);
    expect(page2.rows.map((r) => r.idempotencyKey)).toEqual(["k_2", "k_1"]);
    // no overlap between pages
    const ids1 = page1.rows.map((r) => r.id);
    const ids2 = page2.rows.map((r) => r.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it("filters by action", async () => {
    const a = await seedAccount();
    tracker.push(a);
    await seedAudit(a, "grant", 10n, "g1");
    await seedAudit(a, "adjust", -5n, "a1");
    const grants = await listRecentAdminAudit({ action: "grant" });
    expect(grants.rows.every((r) => r.action === "grant")).toBe(true);
    expect(grants.rows.some((r) => r.idempotencyKey === "g1")).toBe(true);
    expect(grants.rows.some((r) => r.idempotencyKey === "a1")).toBe(false);
  });

  it("combines the action filter with cursor paging", async () => {
    const a = await seedAccount();
    tracker.push(a);
    for (let i = 0; i < 4; i++)
      await seedAudit(a, "grant", BigInt(i + 1), `cg_${i}`);
    for (let i = 0; i < 2; i++)
      await seedAudit(a, "adjust", -BigInt(i + 1), `ca_${i}`);

    const page1 = await listRecentAdminAudit({ action: "grant", limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listRecentAdminAudit({
      action: "grant",
      limit: 2,
      cursor: decodeAuditCursor(page1.nextCursor as string),
    });

    const all = [...page1.rows, ...page2.rows];
    expect(all.every((r) => r.action === "grant")).toBe(true);
    const ids1 = page1.rows.map((r) => r.id);
    const ids2 = page2.rows.map((r) => r.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it("pages stably when rows share the same createdAt (id tiebreaker)", async () => {
    const a = await seedAccount();
    tracker.push(a);
    // Force identical createdAt across 4 rows.
    const at = new Date("2026-07-14T00:00:00.000Z");
    for (let i = 0; i < 4; i++) {
      await prisma.adminAudit.create({
        data: {
          accountId: a,
          actorEmail: "admin@test",
          action: "grant",
          deltaCredits: BigInt(i + 1),
          reason: "tie",
          idempotencyKey: `tie_${i}`,
          createdAt: at,
        },
      });
    }
    const seen = new Set<string>();
    let cursor = null as ReturnType<typeof decodeAuditCursor>;
    for (let i = 0; i < 4; i++) {
      const page = await listRecentAdminAudit({ limit: 1, cursor });
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0].reason).toBe("tie");
      const id = page.rows[0].id;
      expect(seen.has(id)).toBe(false); // no dupes
      seen.add(id);
      cursor = page.nextCursor ? decodeAuditCursor(page.nextCursor) : null;
    }
    expect(seen.size).toBe(4); // no skips
  });

  it("round-trips the cursor and rejects garbage + non-uuid ids", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const c = encodeAuditCursor({
      createdAt: new Date("2026-07-14T00:00:00.000Z"),
      id,
    });
    const d = decodeAuditCursor(c);
    expect(d?.id).toBe(id);
    expect(d?.createdAt.toISOString()).toBe("2026-07-14T00:00:00.000Z");
    expect(decodeAuditCursor("not-a-cursor%%%")).toBeNull();
    // A valid timestamp with a non-uuid id must be rejected — otherwise the
    // keyset compares it against the uuid `id` column and 500s (22P02).
    const nonUuid = Buffer.from("2026-07-14T00:00:00.000Z|not-a-uuid").toString(
      "base64url",
    );
    expect(decodeAuditCursor(nonUuid)).toBeNull();
  });
});
