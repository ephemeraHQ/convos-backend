import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeAdminAudit } from "@/api/v2/credits-admin/audit-repository";
import {
  adminRequest,
  buildCreditsAdminApp,
  cleanupAdminAccounts,
  seedAccount,
} from "./helpers";

type AuditRow = {
  id: string;
  actorEmail: string;
  action: string;
  deltaCredits: string;
  reason: string;
  idempotencyKey: string;
  createdAt: string;
};

describe("GET /api/v2/credits-admin/audit", () => {
  let app: Express;
  const tracker: string[] = [];
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });
  afterEach(async () => {
    await cleanupAdminAccounts(tracker);
    tracker.length = 0;
  });

  it("returns admin actions for an account, newest first, deltaCredits as string", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/grant`,
      {
        credits: 500,
        reason: "first",
        idempotencyKey: `admin_grant_${randomUUID()}`,
      },
    );
    await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/adjust`,
      {
        delta: -100,
        reason: "second",
        idempotencyKey: `admin_adjust_${randomUUID()}`,
      },
    );

    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/audit?accountId=${accountId}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { audit: AuditRow[] };
    expect(body.audit).toHaveLength(2);
    expect(body.audit[0].reason).toBe("second");
    expect(body.audit[0].deltaCredits).toBe("-100");
    expect(body.audit[1].deltaCredits).toBe("500");
  });

  it("invalid accountId query → 400", async () => {
    const res = await adminRequest(app).get(
      "/api/v2/credits-admin/audit?accountId=not-a-uuid",
    );
    expect(res.status).toBe(400);
  });

  it("paginates per-account audit with a nextCursor, then exhausts", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    for (let i = 0; i < 55; i++) {
      await writeAdminAudit({
        accountId,
        actorEmail: "admin@test",
        action: "grant",
        deltaCredits: BigInt(i + 1),
        reason: `seed_${i}`,
        idempotencyKey: `ap_${i}`,
      });
    }
    const p1 = await adminRequest(app).get(
      `/api/v2/credits-admin/audit?accountId=${accountId}`,
    );
    expect(p1.status).toBe(200);
    const b1 = p1.body as {
      audit: { id: string }[];
      nextCursor: string | null;
    };
    expect(b1.audit).toHaveLength(50);
    expect(b1.nextCursor).toBeTruthy();

    const p2 = await adminRequest(app).get(
      `/api/v2/credits-admin/audit?accountId=${accountId}&cursor=${encodeURIComponent(
        b1.nextCursor as string,
      )}`,
    );
    const b2 = p2.body as {
      audit: { id: string }[];
      nextCursor: string | null;
    };
    expect(b2.audit).toHaveLength(5);
    expect(b2.nextCursor).toBeNull();
    const ids = new Set(b1.audit.map((r) => r.id));
    expect(b2.audit.every((r) => !ids.has(r.id))).toBe(true);
  });

  it("400 on an undecodable audit cursor", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/audit?accountId=${accountId}&cursor=notacursor`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_cursor" });
  });
});
