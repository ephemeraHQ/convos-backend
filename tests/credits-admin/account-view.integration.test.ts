import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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
  } | null;
  isEntitled: boolean;
  spendableCredits: string;
  rawBalanceCredits: string;
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

  it("entitled subscriber → spendable == raw wallet (single-ledger), isEntitled true", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    // Single-ledger: subscribing materializes a sub_grant into the one wallet,
    // so spendable and raw are the SAME positive value (no derived path).
    await seedPlusMonthlySubscription(accountId);
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts/${accountId}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as AccountViewBody;
    expect(body.isEntitled).toBe(true);
    expect(body.subscription?.effectiveStatus).toBe("active");
    expect(BigInt(body.rawBalanceCredits)).toBeGreaterThan(0n);
    expect(body.spendableCredits).toBe(body.rawBalanceCredits);
  });

  it("non-subscriber → no subscription, spendable equals raw", async () => {
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
    expect(body.rawBalanceCredits).toBe("1000");
    expect(body.spendableCredits).toBe("1000");
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
});
