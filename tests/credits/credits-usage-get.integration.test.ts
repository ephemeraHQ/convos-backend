import { randomUUID } from "node:crypto";
import { LedgerReason } from "@prisma/client";
import type { Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { truncUtcBucket } from "@/payments/credits/usage-window";
import { startOfTodayUtc, ymdUtc } from "@/payments/daily-refill/utc";
import { prisma } from "@/utils/prisma";
import {
  agentRequest,
  buildCreditsApp,
  cleanupAccounts,
  clearAgentApiKeyOverride,
  installAgentApiKeyOverride,
  seedAccount,
} from "./helpers";

let app: Express;
const tracker: string[] = [];

const TODAY = startOfTodayUtc(new Date());
const dayMidnight = (offset: number): Date => {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
};
const dayNoon = (offset: number): Date => {
  const d = dayMidnight(offset);
  d.setUTCHours(12);
  return d;
};

const seedLedger = async (
  accountId: string,
  credits: number,
  reason: LedgerReason,
  at: Date,
): Promise<void> => {
  // consume deltas are stored negative; grants positive.
  const delta =
    reason === LedgerReason.consume ? BigInt(-credits) : BigInt(credits);
  await prisma.creditLedger.create({
    data: {
      accountId,
      delta,
      reason,
      idempotencyKey: `seed-${accountId}-${randomUUID()}`,
      scope: "transaction",
      createdAt: at,
    },
  });
};

type SeriesPoint = { date: string; consumed: number };
const sumConsumed = (series: SeriesPoint[]): number =>
  series.reduce((sum, p) => sum + p.consumed, 0);

beforeAll(() => {
  installAgentApiKeyOverride();
  app = buildCreditsApp();
});
afterEach(async () => {
  await cleanupAccounts(tracker);
  tracker.length = 0;
});
afterAll(() => {
  clearAgentApiKeyOverride();
});

describe("GET /v2/accounts/:accountId/credits/usage", () => {
  it("day buckets: zero-fills the window and groups consumption by UTC day", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedLedger(accountId, 100, LedgerReason.consume, dayNoon(0));
    await seedLedger(accountId, 50, LedgerReason.consume, dayNoon(-2));
    // A grant on the same day must NOT count toward consumption.
    await seedLedger(accountId, 1000, LedgerReason.grant, dayNoon(0));

    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits/usage?days=7&bucket=day`,
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      accountId: string;
      days: number;
      bucket: string;
      series: SeriesPoint[];
    };
    expect(body).toMatchObject({ accountId, days: 7, bucket: "day" });
    expect(body.series).toHaveLength(7);
    expect(body.series[0].date).toBe(ymdUtc(dayMidnight(-6)));
    expect(body.series[6].date).toBe(ymdUtc(TODAY));

    const byDate = Object.fromEntries(
      body.series.map((p) => [p.date, p.consumed]),
    );
    expect(byDate[ymdUtc(TODAY)]).toBe(100);
    expect(byDate[ymdUtc(dayMidnight(-2))]).toBe(50);
    expect(sumConsumed(body.series)).toBe(150);
  });

  it("defaults to a 30-day, day-bucketed window", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits/usage`,
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      days: number;
      bucket: string;
      series: SeriesPoint[];
    };
    expect(body.days).toBe(30);
    expect(body.bucket).toBe("day");
    expect(body.series).toHaveLength(30);
  });

  it("week buckets: coalesces into Monday-aligned buckets", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    // today + yesterday (recent), and one two weeks back (isolated).
    await seedLedger(accountId, 100, LedgerReason.consume, dayNoon(0));
    await seedLedger(accountId, 25, LedgerReason.consume, dayNoon(-1));
    await seedLedger(accountId, 70, LedgerReason.consume, dayNoon(-14));

    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits/usage?days=30&bucket=week`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { bucket: string; series: SeriesPoint[] };
    expect(body.bucket).toBe("week");

    // Weekday-independent invariants (the run day shifts which week each seed
    // falls in, but these always hold):
    // 1. every bucket key is a Monday (UTC).
    for (const p of body.series) {
      expect(new Date(`${p.date}T00:00:00Z`).getUTCDay()).toBe(1);
    }
    // 2. all consumption is accounted for.
    expect(sumConsumed(body.series)).toBe(195);

    const byDate = Object.fromEntries(
      body.series.map((p) => [p.date, p.consumed]),
    );
    // 3. the isolated -14 seed sits alone in its week.
    expect(byDate[ymdUtc(truncUtcBucket(dayMidnight(-14), "week"))]).toBe(70);
    // 4. today + yesterday (same or adjacent weeks) total 125 across their weeks.
    const recentWeeks = new Set([
      ymdUtc(truncUtcBucket(TODAY, "week")),
      ymdUtc(truncUtcBucket(dayMidnight(-1), "week")),
    ]);
    let recentTotal = 0;
    recentWeeks.forEach((k) => {
      recentTotal += byDate[k] ?? 0;
    });
    expect(recentTotal).toBe(125);
  });

  it("month buckets: coalesces into 1st-of-month-aligned buckets", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    // today (this month) and one 40 days back (always a prior month, since no
    // month exceeds 31 days).
    await seedLedger(accountId, 100, LedgerReason.consume, dayNoon(0));
    await seedLedger(accountId, 50, LedgerReason.consume, dayNoon(-40));

    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits/usage?days=60&bucket=month`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { bucket: string; series: SeriesPoint[] };
    expect(body.bucket).toBe("month");
    // Every bucket key is the 1st of a month (UTC).
    for (const p of body.series) {
      expect(new Date(`${p.date}T00:00:00Z`).getUTCDate()).toBe(1);
    }
    expect(sumConsumed(body.series)).toBe(150);
    const byDate = Object.fromEntries(
      body.series.map((p) => [p.date, p.consumed]),
    );
    expect(byDate[ymdUtc(truncUtcBucket(TODAY, "month"))]).toBe(100);
    expect(byDate[ymdUtc(truncUtcBucket(dayMidnight(-40), "month"))]).toBe(50);
  });

  it("month buckets: a 90-day window spans 3+ months", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    // Three seeds 35 days apart land in three distinct months (no month exceeds
    // 31 days), with any intervening month zero-filled.
    await seedLedger(accountId, 100, LedgerReason.consume, dayNoon(0));
    await seedLedger(accountId, 50, LedgerReason.consume, dayNoon(-35));
    await seedLedger(accountId, 25, LedgerReason.consume, dayNoon(-70));

    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits/usage?days=90&bucket=month`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { bucket: string; series: SeriesPoint[] };
    expect(body.bucket).toBe("month");
    expect(body.series.length).toBeGreaterThanOrEqual(3);
    for (const p of body.series) {
      expect(new Date(`${p.date}T00:00:00Z`).getUTCDate()).toBe(1);
    }
    expect(sumConsumed(body.series)).toBe(175);
    const byDate = Object.fromEntries(
      body.series.map((p) => [p.date, p.consumed]),
    );
    expect(byDate[ymdUtc(truncUtcBucket(TODAY, "month"))]).toBe(100);
    expect(byDate[ymdUtc(truncUtcBucket(dayMidnight(-35), "month"))]).toBe(50);
    expect(byDate[ymdUtc(truncUtcBucket(dayMidnight(-70), "month"))]).toBe(25);
  });

  it("returns 400 invalid_request for a non-integer days param", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    // z.coerce.number().int() parses "30.5" then rejects the non-integer.
    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits/usage?days=30.5`,
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_request");
  });

  it("returns all-zero series for an account with no consumption", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits/usage?days=5`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { series: SeriesPoint[] };
    expect(body.series).toHaveLength(5);
    expect(body.series.every((p) => p.consumed === 0)).toBe(true);
  });

  it("returns 404 account_not_found for a UUID with no Account", async () => {
    const fakeId = "11111111-2222-3333-4444-555555555555";
    const res = await agentRequest(app).get(
      `/v2/accounts/${fakeId}/credits/usage`,
    );
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe("account_not_found");
  });

  it("returns 400 invalid_request for an out-of-range days param", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits/usage?days=0`,
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_request");
  });

  it("returns 400 invalid_request for days above the max (366)", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits/usage?days=366`,
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_request");
  });

  it("returns 400 invalid_request for an unknown bucket", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits/usage?bucket=hour`,
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_request");
  });

  it("returns 400 invalid_account_id for a non-UUID path param", async () => {
    const res = await agentRequest(app).get(
      "/v2/accounts/not-a-uuid/credits/usage",
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_account_id");
  });
});
