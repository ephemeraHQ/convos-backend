import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/utils/prisma";

describe("AdminAudit model", () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const id of created) {
      await prisma.adminAudit.deleteMany({ where: { id } });
    }
    created.length = 0;
  });

  it("persists and reads back a row with a server-generated uuid", async () => {
    const row = await prisma.adminAudit.create({
      data: {
        accountId: randomUUID(),
        actorEmail: "admin@convos.test",
        action: "grant",
        deltaCredits: 500_000n,
        reason: "manual top-up",
        idempotencyKey: `admin_grant_${randomUUID()}`,
      },
    });
    created.push(row.id);
    expect(row.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(row.actorEmail).toBe("admin@convos.test");
    expect(row.action).toBe("grant");
    expect(row.reason).toBe("manual top-up");
    expect(row.deltaCredits).toBe(500_000n);
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
