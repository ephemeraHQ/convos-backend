import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MAX_ACCOUNTS_PAGE } from "@/api/v2/credits-admin/schemas/requests";
import { prisma } from "@/utils/prisma";
import {
  adminRequest,
  buildCreditsAdminApp,
  cleanupAdminAccounts,
  seedAccount,
  seedPlusMonthlySubscription,
} from "./helpers";

type Row = {
  accountId: string;
  balanceCredits: string;
  tier?: string;
  latestGrantAt?: string;
  lastConsumeAt?: string | null;
};
type Body = { mode: string; page: number; hasMore: boolean; rows: Row[] };

const DAY_MS = 86400000;

/**
 * Distinctive so `min=max=BALANCE` selects essentially only the seeded row —
 * this is a GLOBAL query against a shared DB. Deliberately not a round number
 * another fixture might reuse.
 */
const BALANCE = 8675309n;

const setBalance = async (accountId: string, balance: bigint) => {
  await prisma.userCredits.upsert({
    where: { accountId },
    update: { balance },
    create: { accountId, balance },
  });
};

const addLedger = async (
  accountId: string,
  reason: "grant" | "consume" | "adjust",
  delta: bigint,
  grantKindId: string | null,
  createdAt: Date,
) => {
  await prisma.creditLedger.create({
    data: {
      accountId,
      delta,
      reason,
      grantKindId,
      idempotencyKey: `k_${accountId}_${createdAt.getTime()}_${Math.abs(Number(delta))}`,
      createdAt,
    },
  });
};

describe("GET /api/v2/credits-admin/accounts", () => {
  let app: Express;
  const tracker: string[] = [];
  const kindTracker: string[] = [];
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });
  afterEach(async () => {
    await cleanupAdminAccounts(tracker);
    tracker.length = 0;
    for (const kind of kindTracker) {
      await prisma.grantKind.deleteMany({ where: { id: kind } });
    }
    kindTracker.length = 0;
  });

  /**
   * `activity` admits no self-selecting filter (dormant is a global scan over
   * UserCredits, and NULLS LAST sorts never-consumed rows last), so walk pages
   * rather than assume the seeded row lands on page 0 of a shared DB.
   */
  const findAcrossPages = async (query: string, accountId: string) => {
    for (let page = 0; page <= 20; page++) {
      const res = await adminRequest(app).get(
        `/api/v2/credits-admin/accounts?${query}&limit=100&page=${page}`,
      );
      expect(res.status).toBe(200);
      const body = res.body as Body;
      const hit = body.rows.find((r) => r.accountId === accountId);
      if (hit) return hit;
      if (!body.hasMore) return undefined;
    }
    return undefined;
  };

  it("401 without bearer token", async () => {
    const res = await adminRequest(app, false).get(
      "/api/v2/credits-admin/accounts?mode=balance",
    );
    expect(res.status).toBe(401);
  });

  it("balance mode returns stringified balances, sorted", async () => {
    const a = await seedAccount();
    tracker.push(a);
    await setBalance(a, BALANCE);
    const v = BALANCE.toString();
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts?mode=balance&min=${v}&max=${v}&sort=desc`,
    );
    expect(res.status).toBe(200);
    const body = res.body as Body;
    expect(body.mode).toBe("balance");
    expect(body.page).toBe(0);
    const seededRow = body.rows.find((r) => r.accountId === a);
    expect(seededRow?.balanceCredits).toBe(v);
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

  it("grantKind mode returns the latest grant for that kind as an ISO string", async () => {
    const a = await seedAccount();
    tracker.push(a);
    const kind = `t_al_${randomUUID().slice(0, 8)}`;
    await prisma.grantKind.create({
      data: { id: kind, name: "accounts-list test kind" },
    });
    kindTracker.push(kind);
    await setBalance(a, 555n);
    const older = new Date(Date.now() - 2 * DAY_MS);
    const latest = new Date(Date.now() - 1 * DAY_MS);
    await addLedger(a, "grant", 100n, kind, older);
    await addLedger(a, "grant", 200n, kind, latest);

    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts?mode=grantKind&kind=${kind}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as Body;
    // Kind is unique to this test, so the result set is exactly this row.
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].accountId).toBe(a);
    expect(body.rows[0].balanceCredits).toBe("555");
    expect(body.rows[0].latestGrantAt).toBe(latest.toISOString());
  });

  it("activity dormant mode serializes lastConsumeAt as ISO string, or null when never consumed", async () => {
    const neverConsumed = await seedAccount();
    const staleConsumer = await seedAccount();
    tracker.push(neverConsumed, staleConsumer);
    await setBalance(neverConsumed, 111n);
    await setBalance(staleConsumer, 222n);
    const staleAt = new Date(Date.now() - 60 * DAY_MS);
    await addLedger(staleConsumer, "consume", -5n, null, staleAt);

    const query = "mode=activity&state=dormant&days=30";
    const neverRow = await findAcrossPages(query, neverConsumed);
    const staleRow = await findAcrossPages(query, staleConsumer);

    // Pins the `?.toISOString() ?? null` ternary on the wire: key present and
    // JSON null, not undefined and not omitted.
    expect(neverRow).toHaveProperty("lastConsumeAt", null);
    expect(staleRow?.lastConsumeAt).toBe(staleAt.toISOString());
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

  it("400 on over-cap page rather than a Postgres-range 500", async () => {
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts?mode=balance&page=${MAX_ACCOUNTS_PAGE + 1}`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_request" });
  });

  it("400 on bigint-overflow-scale page, min and maxBalance", async () => {
    const page = await adminRequest(app).get(
      "/api/v2/credits-admin/accounts?mode=balance&page=1e21",
    );
    expect(page.status).toBe(400);
    const min = await adminRequest(app).get(
      "/api/v2/credits-admin/accounts?mode=balance&min=1e21",
    );
    expect(min.status).toBe(400);
    const maxBalance = await adminRequest(app).get(
      "/api/v2/credits-admin/accounts?mode=broken&maxBalance=1e21",
    );
    expect(maxBalance.status).toBe(400);
  });
});
