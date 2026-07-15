import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  listAdminAuditByAccount,
  writeAdminAudit,
} from "@/api/v2/credits-admin/audit-repository";
import { prisma } from "@/utils/prisma";

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
