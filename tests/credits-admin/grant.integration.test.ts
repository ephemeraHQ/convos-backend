import { randomUUID } from "node:crypto";
import { LedgerReason } from "@prisma/client";
import type { Express } from "express";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CF_IDENTITY_SENTINEL } from "@/api/v2/credits-admin/middleware/cf-identity";
import { getBalance } from "@/payments";
import { prisma } from "@/utils/prisma";
import {
  adminRequest,
  buildCreditsAdminApp,
  cleanupAdminAccounts,
  seedAccount,
} from "./helpers";

describe("POST /api/v2/credits-admin/accounts/:accountId/grant", () => {
  let app: Express;
  const tracker: string[] = [];
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });
  afterEach(async () => {
    await cleanupAdminAccounts(tracker);
    tracker.length = 0;
  });

  it("grants via grant(): kind=manual ledger, admin note, AdminAudit row", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const idempotencyKey = `admin_grant_${randomUUID()}`;
    const res = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/grant`,
      { credits: 500_000, reason: "support top-up", idempotencyKey },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      applied: true,
      replayed: false,
      balanceAfter: "500000",
      newBalance: "500000",
    });
    expect(await getBalance(accountId)).toBe(500_000n);

    const ledger = await prisma.creditLedger.findFirst({
      where: { accountId, idempotencyKey },
    });
    expect(ledger?.grantKindId).toBe("manual");
    expect(ledger?.reason).toBe(LedgerReason.grant);
    expect(ledger?.note).toBe(`admin:${CF_IDENTITY_SENTINEL} — support top-up`);

    const audit = await prisma.adminAudit.findMany({ where: { accountId } });
    expect(audit).toHaveLength(1);
    expect(audit[0].actorEmail).toBe(CF_IDENTITY_SENTINEL);
    expect(audit[0].action).toBe("grant");
    expect(audit[0].deltaCredits).toBe(500_000n);
    expect(audit[0].reason).toBe("support top-up");
    expect(audit[0].idempotencyKey).toBe(idempotencyKey);
  });

  it("idempotency mismatch (same key, different payload) → 409", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const idempotencyKey = `admin_grant_${randomUUID()}`;
    await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/grant`,
      { credits: 100, reason: "first", idempotencyKey },
    );
    const res = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/grant`,
      { credits: 999, reason: "first", idempotencyKey },
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "idempotency_mismatch" });
  });

  it("idempotent replay: second call replays, no second audit row", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const idempotencyKey = `admin_grant_${randomUUID()}`;
    const body = { credits: 1_000, reason: "dup", idempotencyKey };
    const res1 = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/grant`,
      body,
    );
    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({ replayed: false });
    const res2 = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/grant`,
      body,
    );
    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({ replayed: true });
    expect(await getBalance(accountId)).toBe(1_000n);
    const audit = await prisma.adminAudit.findMany({ where: { accountId } });
    expect(audit).toHaveLength(1);
  });

  it("replay re-creates a missing audit row (idempotent upsert closes the gap)", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const idempotencyKey = `admin_grant_${randomUUID()}`;
    const body = { credits: 100, reason: "recover", idempotencyKey };
    await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/grant`,
      body,
    );
    await prisma.adminAudit.deleteMany({ where: { accountId } });
    const res = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/grant`,
      body,
    );
    expect(res.body).toMatchObject({ replayed: true });
    const audit = await prisma.adminAudit.findMany({ where: { accountId } });
    expect(audit).toHaveLength(1);
  });

  it("missing reason → 400, no ledger/audit write", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/grant`,
      { credits: 100, idempotencyKey: `admin_grant_${randomUUID()}` },
    );
    expect(res.status).toBe(400);
    expect(await getBalance(accountId)).toBe(0n);
    expect(await prisma.adminAudit.count({ where: { accountId } })).toBe(0);
  });

  it("missing admin token → 401, no write", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await adminRequest(app, false).post(
      `/api/v2/credits-admin/accounts/${accountId}/grant`,
      {
        credits: 100,
        reason: "x",
        idempotencyKey: `admin_grant_${randomUUID()}`,
      },
    );
    expect(res.status).toBe(401);
    expect(await getBalance(accountId)).toBe(0n);
    expect(await prisma.adminAudit.count({ where: { accountId } })).toBe(0);
  });

  it("unknown account → 404", async () => {
    const res = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${randomUUID()}/grant`,
      {
        credits: 100,
        reason: "x",
        idempotencyKey: `admin_grant_${randomUUID()}`,
      },
    );
    expect(res.status).toBe(404);
  });
});
