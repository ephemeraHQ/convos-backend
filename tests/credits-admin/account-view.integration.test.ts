import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/utils/prisma";
import {
  adminRequest,
  buildCreditsAdminApp,
  cleanupAdminAccounts,
  seedAccount,
  seedBalance,
  seedPlusMonthlySubscription,
} from "./helpers";

type AccountViewBody = {
  accountId: string;
  accountCreatedAt: string;
  subscription: {
    tier: string;
    storedStatus: string;
    effectiveStatus: string;
    isEntitled: boolean;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    environment: string | null;
    willRenew: boolean;
    isInTrial: boolean;
    perPeriodCredits: number;
  } | null;
  isEntitled: boolean;
  balanceCredits: string;
  periodConsumesCredits: number;
  ledger: {
    id: string;
    delta: string;
    reason: string;
    grantKindId: string | null;
    note: string | null;
    balanceAfter: string | null;
    idempotencyKey: string;
    createdAt: string;
  }[];
  ledgerNextCursor: string | null;
  dailyRefills: unknown[];
  usageDaily: unknown[];
};

describe("GET /api/v2/credits-admin/accounts/:accountId", () => {
  let app: Express;
  const tracker: string[] = [];
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });
  afterEach(async () => {
    await cleanupAdminAccounts(tracker);
    tracker.length = 0;
  });

  it("entitled subscriber → balance is the materialized wallet (single-ledger), isEntitled true", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    // Single-ledger: subscribing materializes a sub_grant into the one wallet,
    // so the balance is a single positive value (no derived/parked split).
    await seedPlusMonthlySubscription(accountId);
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts/${accountId}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as AccountViewBody;
    expect(body.isEntitled).toBe(true);
    expect(body.subscription?.effectiveStatus).toBe("active");
    expect(BigInt(body.balanceCredits)).toBeGreaterThan(0n);
    expect(body.subscription?.perPeriodCredits).toBeGreaterThan(0);
  });

  it("non-subscriber → no subscription, single wallet balance", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 1_000n);
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts/${accountId}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as AccountViewBody;
    expect(body.subscription).toBeNull();
    expect(body.isEntitled).toBe(false);
    expect(body.balanceCredits).toBe("1000");
    expect(body.ledger.length).toBeGreaterThanOrEqual(1);
    expect(body.ledger[0].delta).toBe("1000");
  });

  it("unknown account → 404", async () => {
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts/${randomUUID()}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "account_not_found" });
  });

  it("invalid uuid param → 400 (meGuard)", async () => {
    const res = await adminRequest(app).get(
      "/api/v2/credits-admin/accounts/not-a-uuid",
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_account_id" });
  });

  const seedLedger = async (accountId: string, n: number) => {
    const base = Date.now() - 300 * 86400000;
    for (let i = 0; i < n; i++) {
      await prisma.creditLedger.create({
        data: {
          accountId,
          delta: BigInt(i + 1),
          reason: "grant",
          grantKindId: null,
          idempotencyKey: `av_${accountId}_${i}`,
          createdAt: new Date(base + i * 60000),
        },
      });
    }
  };

  it("returns ledgerNextCursor when more than 50 ledger rows exist", async () => {
    const a = await seedAccount();
    tracker.push(a);
    await seedLedger(a, 51);
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts/${a}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as AccountViewBody;
    expect(body.ledger).toHaveLength(50);
    expect(body.ledgerNextCursor).toBeTruthy();
  });

  it("ledgerNextCursor is null when 50 or fewer ledger rows exist", async () => {
    const a = await seedAccount();
    tracker.push(a);
    await seedLedger(a, 5);
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts/${a}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as AccountViewBody;
    expect(body.ledger).toHaveLength(5);
    expect(body.ledgerNextCursor).toBeNull();
  });
});
