import type { Express } from "express";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/utils/prisma";
import {
  adminRequest,
  buildCreditsAdminApp,
  cleanupAdminAccounts,
  seedAccount,
  seedPlusMonthlySubscription,
} from "./helpers";

type Row = { accountId: string; balanceCredits: string; tier?: string };
type Body = { mode: string; page: number; hasMore: boolean; rows: Row[] };

const setBalance = async (accountId: string, balance: bigint) => {
  await prisma.userCredits.upsert({
    where: { accountId },
    update: { balance },
    create: { accountId, balance },
  });
};

describe("GET /api/v2/credits-admin/accounts", () => {
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
      "/api/v2/credits-admin/accounts?mode=balance",
    );
    expect(res.status).toBe(401);
  });

  it("balance mode returns stringified balances, sorted", async () => {
    const a = await seedAccount();
    tracker.push(a);
    await setBalance(a, 4242n);
    const res = await adminRequest(app).get(
      "/api/v2/credits-admin/accounts?mode=balance&min=1&sort=desc&limit=100",
    );
    expect(res.status).toBe(200);
    const body = res.body as Body;
    expect(body.mode).toBe("balance");
    expect(typeof body.rows[0].balanceCredits).toBe("string");
    const seededRow = body.rows.find((r) => r.accountId === a);
    expect(seededRow).toBeDefined();
    expect(seededRow?.balanceCredits).toBe("4242");
  });

  it("broken mode surfaces entitled sub with balance 0", async () => {
    const a = await seedAccount();
    tracker.push(a);
    await seedPlusMonthlySubscription(a);
    await setBalance(a, 0n);
    const res = await adminRequest(app).get(
      "/api/v2/credits-admin/accounts?mode=broken&maxBalance=0&limit=100",
    );
    expect(res.status).toBe(200);
    const body = res.body as Body;
    const seededRow = body.rows.find((r) => r.accountId === a);
    expect(seededRow).toBeDefined();
    expect(seededRow?.tier).toBeTruthy();
  });

  it("400 on invalid mode", async () => {
    const res = await adminRequest(app).get(
      "/api/v2/credits-admin/accounts?mode=nonsense",
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_request" });
  });

  it("400 on grantKind without kind", async () => {
    const res = await adminRequest(app).get(
      "/api/v2/credits-admin/accounts?mode=grantKind",
    );
    expect(res.status).toBe(400);
  });
});
