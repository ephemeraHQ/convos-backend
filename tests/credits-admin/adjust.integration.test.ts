import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CF_IDENTITY_SENTINEL } from "@/api/v2/credits-admin/middleware/cf-identity";
import { getBalance } from "@/payments";
import { prisma } from "@/utils/prisma";
import {
  adminRequest,
  buildCreditsAdminApp,
  cleanupAdminAccounts,
  clearCfIdentity,
  seedAccount,
  seedBalance,
  seedCfIdentity,
} from "./helpers";

describe("POST /api/v2/credits-admin/accounts/:accountId/adjust", () => {
  let app: Express;
  const tracker: string[] = [];
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });
  afterEach(async () => {
    clearCfIdentity();
    await cleanupAdminAccounts(tracker);
    tracker.length = 0;
  });

  it("positive delta: applies, writes audit with signed delta + admin note", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 1_000n);
    const idempotencyKey = `admin_adjust_${randomUUID()}`;
    const res = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/adjust`,
      { delta: 250, reason: "correction up", idempotencyKey },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      applied: true,
      replayed: false,
      balanceAfter: "1250",
    });
    expect(await getBalance(accountId)).toBe(1_250n);
    const audit = await prisma.adminAudit.findFirst({
      where: { accountId, idempotencyKey },
    });
    expect(audit?.action).toBe("adjust");
    expect(audit?.deltaCredits).toBe(250n);
    const ledger = await prisma.creditLedger.findFirst({
      where: { accountId, idempotencyKey },
    });
    expect(ledger?.note).toBe(`admin:${CF_IDENTITY_SENTINEL} — correction up`);
  });

  it("negative delta within floor: applies down", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 1_000n);
    const res = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/adjust`,
      {
        delta: -300,
        reason: "clawback",
        idempotencyKey: `admin_adjust_${randomUUID()}`,
      },
    );
    expect(res.status).toBe(200);
    expect(await getBalance(accountId)).toBe(700n);
    const audit = await prisma.adminAudit.findFirst({ where: { accountId } });
    expect(audit?.deltaCredits).toBe(-300n);
  });

  it("unknown account → 404", async () => {
    const res = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${randomUUID()}/adjust`,
      {
        delta: 100,
        reason: "x",
        idempotencyKey: `admin_adjust_${randomUUID()}`,
      },
    );
    expect(res.status).toBe(404);
  });

  it("negative delta breaching minBalance floor → 402, no write", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 100n);
    const res = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/adjust`,
      {
        delta: -5_000,
        reason: "too much",
        idempotencyKey: `admin_adjust_${randomUUID()}`,
      },
    );
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "insufficient_balance" });
    expect(await getBalance(accountId)).toBe(100n);
    expect(await prisma.adminAudit.count({ where: { accountId } })).toBe(0);
  });

  it("delta = 0 → 400", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/adjust`,
      {
        delta: 0,
        reason: "noop",
        idempotencyKey: `admin_adjust_${randomUUID()}`,
      },
    );
    expect(res.status).toBe(400);
  });

  it("idempotent replay: no double-apply, single audit row", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 1_000n);
    const body = {
      delta: 100,
      reason: "dup",
      idempotencyKey: `admin_adjust_${randomUUID()}`,
    };
    const res1 = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/adjust`,
      body,
    );
    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({ replayed: false });
    const res2 = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/adjust`,
      body,
    );
    expect(res2.body).toMatchObject({ replayed: true });
    expect(await getBalance(accountId)).toBe(1_100n);
    expect(await prisma.adminAudit.count({ where: { accountId } })).toBe(1);
  });

  it("401 without admin token → no write", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 1_000n);
    const res = await adminRequest(app, false).post(
      `/api/v2/credits-admin/accounts/${accountId}/adjust`,
      { delta: 10, reason: "x", idempotencyKey: `admin_adjust_${accountId}_a` },
    );
    expect(res.status).toBe(401);
    expect(await getBalance(accountId)).toBe(1_000n);
    expect(await prisma.adminAudit.count({ where: { accountId } })).toBe(0);
  });

  it("records sentinel actor when no CF assertion", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 1_000n);
    const res = await adminRequest(app).post(
      `/api/v2/credits-admin/accounts/${accountId}/adjust`,
      { delta: 10, reason: "x", idempotencyKey: `admin_adjust_${accountId}_b` },
    );
    expect(res.status).toBe(200);
    const row = await prisma.adminAudit.findFirst({
      where: { accountId, idempotencyKey: `admin_adjust_${accountId}_b` },
    });
    expect(row?.actorEmail).toBe(CF_IDENTITY_SENTINEL);
  });

  it("records verified email when CF assertion valid", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 1_000n);
    const sign = await seedCfIdentity();
    const assertion = await sign("ops@convos.xyz");
    const res = await adminRequest(app)
      .post(`/api/v2/credits-admin/accounts/${accountId}/adjust`, {
        delta: 10,
        reason: "x",
        idempotencyKey: `admin_adjust_${accountId}_c`,
      })
      .set("Cf-Access-Jwt-Assertion", assertion);
    expect(res.status).toBe(200);
    const row = await prisma.adminAudit.findFirst({
      where: { accountId, idempotencyKey: `admin_adjust_${accountId}_c` },
    });
    expect(row?.actorEmail).toBe("ops@convos.xyz");
  });
});
