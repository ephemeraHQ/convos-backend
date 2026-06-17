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
    }
    accounts.length = 0;
  });

  it("writes a row and lists it back, newest first", async () => {
    const accountId = randomUUID();
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
    expect(rows[0].reason).toBe("second");
    expect(rows[0].action).toBe("adjust");
    expect(rows[0].deltaCredits).toBe(-100n);
    expect(rows[1].reason).toBe("first");
  });
});
