import type { Express } from "express";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeAdminAudit } from "@/api/v2/credits-admin/audit-repository";
import {
  adminRequest,
  buildCreditsAdminApp,
  cleanupAdminAccounts,
  seedAccount,
} from "./helpers";

type RecentAuditRow = {
  id: string;
  accountId: string;
  actorEmail: string;
  action: string;
  deltaCredits: string;
  reason: string;
  createdAt: string;
  idempotencyKey: string;
};

type RecentAuditResponse = {
  rows: RecentAuditRow[];
  nextCursor: string | null;
};

describe("GET /api/v2/credits-admin/audit/recent", () => {
  let app: Express;
  const tracker: string[] = [];
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });
  afterEach(async () => {
    await cleanupAdminAccounts(tracker);
    tracker.length = 0;
  });

  it("401 without bearer token", async () => {
    const res = await adminRequest(app, false).get(
      "/api/v2/credits-admin/audit/recent",
    );
    expect(res.status).toBe(401);
  });

  it("paginates newest-first with nextCursor and filters by action", async () => {
    const a = await seedAccount();
    tracker.push(a);
    for (let i = 0; i < 3; i++) {
      await writeAdminAudit({
        accountId: a,
        actorEmail: "admin@test",
        action: i % 2 === 0 ? "grant" : "adjust",
        deltaCredits: BigInt(i + 1),
        reason: "seed",
        idempotencyKey: `ar_${i}`,
      });
    }
    const p1 = await adminRequest(app).get(
      "/api/v2/credits-admin/audit/recent?action=all&",
    );
    expect(p1.status).toBe(200);
    const p1Body = p1.body as RecentAuditResponse;
    expect(Array.isArray(p1Body.rows)).toBe(true);
    expect(typeof p1Body.rows[0].deltaCredits).toBe("string");
    expect(p1Body.rows[0].accountId).toBe(a);

    const grants = await adminRequest(app).get(
      "/api/v2/credits-admin/audit/recent?action=grant",
    );
    const grantsBody = grants.body as RecentAuditResponse;
    expect(grantsBody.rows.every((r) => r.action === "grant")).toBe(true);
  });

  it("400 on an undecodable cursor", async () => {
    // Plain ascii that base64url-decodes to bytes with no "|" separator →
    // decodeAuditCursor returns null → handler 400. (Avoid %-encoding so the
    // raw value reliably reaches the handler rather than tripping the qs parser.)
    const res = await adminRequest(app).get(
      "/api/v2/credits-admin/audit/recent?cursor=notacursor",
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_cursor" });
  });
});
