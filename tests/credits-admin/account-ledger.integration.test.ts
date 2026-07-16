import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/utils/prisma";
import {
  adminRequest,
  buildCreditsAdminApp,
  cleanupAdminAccounts,
  seedAccount,
} from "./helpers";

type LedgerRow = { id: string; delta: string; createdAt: string };
type LedgerResponse = { rows: LedgerRow[]; nextCursor: string | null };

const addLedger = async (
  accountId: string,
  delta: bigint,
  createdAt: Date,
  reason: "consume" | "grant" | "adjust" = "grant",
  grantKindId: string | null = null,
) => {
  await prisma.creditLedger.create({
    data: {
      accountId,
      delta,
      reason,
      grantKindId,
      idempotencyKey: `al_${accountId}_${createdAt.getTime()}_${delta}`,
      createdAt,
    },
  });
};

describe("GET /api/v2/credits-admin/accounts/:accountId/ledger", () => {
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
      `/api/v2/credits-admin/accounts/${randomUUID()}/ledger`,
    );
    expect(res.status).toBe(401);
  });

  it("400 on an invalid-shape accountId (meGuard)", async () => {
    const res = await adminRequest(app).get(
      "/api/v2/credits-admin/accounts/not-a-uuid/ledger",
    );
    expect(res.status).toBe(400);
  });

  it("valid-but-unknown accountId returns an empty page (not 404)", async () => {
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts/${randomUUID()}/ledger`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rows: [], nextCursor: null });
  });

  it("pages 55 rows newest-first, then exhausts", async () => {
    const a = await seedAccount();
    tracker.push(a);
    const base = Date.now() - 200 * 86400000;
    for (let i = 0; i < 55; i++) {
      await addLedger(a, BigInt(i + 1), new Date(base + i * 60000));
    }
    const p1 = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts/${a}/ledger`,
    );
    expect(p1.status).toBe(200);
    const b1 = p1.body as LedgerResponse;
    expect(b1.rows).toHaveLength(50);
    expect(b1.rows[0].delta).toBe("55");
    expect(b1.nextCursor).toBeTruthy();

    const p2 = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts/${a}/ledger?cursor=${encodeURIComponent(
        b1.nextCursor as string,
      )}`,
    );
    const b2 = p2.body as LedgerResponse;
    expect(b2.rows).toHaveLength(5);
    expect(b2.nextCursor).toBeNull();
    const ids = new Set(b1.rows.map((r) => r.id));
    expect(b2.rows.every((r) => !ids.has(r.id))).toBe(true);
  });

  it("400 on an undecodable cursor", async () => {
    const a = await seedAccount();
    tracker.push(a);
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts/${a}/ledger?cursor=notacursor`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_cursor" });
  });

  it("400 (not 500) on a decodable cursor whose id is not a uuid", async () => {
    const a = await seedAccount();
    tracker.push(a);
    const cursor = Buffer.from("2026-07-14T00:00:00.000Z|not-a-uuid").toString(
      "base64url",
    );
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/accounts/${a}/ledger?cursor=${encodeURIComponent(cursor)}`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_cursor" });
  });
});

describe("GET …/ledger — filter params", () => {
  let app2: Express;
  const t2: string[] = [];
  beforeAll(() => {
    app2 = buildCreditsAdminApp();
  });
  afterEach(async () => {
    await cleanupAdminAccounts(t2);
    t2.length = 0;
  });

  it("kind=subscription returns only sub_grant + sub_forfeit", async () => {
    const a = await seedAccount();
    t2.push(a);
    await addLedger(
      a,
      100n,
      new Date("2026-07-10T00:00:00Z"),
      "grant",
      "sub_grant",
    );
    await addLedger(
      a,
      -40n,
      new Date("2026-07-11T00:00:00Z"),
      "adjust",
      "sub_forfeit",
    );
    await addLedger(
      a,
      500n,
      new Date("2026-07-12T00:00:00Z"),
      "grant",
      "manual",
    );
    const res = await adminRequest(app2).get(
      `/api/v2/credits-admin/accounts/${a}/ledger?kind=subscription`,
    );
    expect(res.status).toBe(200);
    const body = res.body as LedgerResponse;
    expect(body.rows).toHaveLength(2);
    expect(new Set(body.rows.map((r) => r.delta))).toEqual(
      new Set(["100", "-40"]),
    );
  });

  it("filters to a single kind with no off-filter leak", async () => {
    const a = await seedAccount();
    t2.push(a);
    // 3 sub_grant + 3 manual, interleaved by day. (The cursor+filter page-2
    // interaction is covered directly at limit:2 in ledger-repository.test.ts;
    // the HTTP endpoint's limit is server-fixed at 50, so here we assert the
    // single filtered page holds exactly the 3 sub_grants and no manual leaks.)
    await addLedger(
      a,
      1n,
      new Date("2026-07-01T00:00:00Z"),
      "grant",
      "sub_grant",
    );
    await addLedger(a, 9n, new Date("2026-07-02T00:00:00Z"), "grant", "manual");
    await addLedger(
      a,
      2n,
      new Date("2026-07-03T00:00:00Z"),
      "grant",
      "sub_grant",
    );
    await addLedger(a, 9n, new Date("2026-07-04T00:00:00Z"), "grant", "manual");
    await addLedger(
      a,
      3n,
      new Date("2026-07-05T00:00:00Z"),
      "grant",
      "sub_grant",
    );
    await addLedger(a, 9n, new Date("2026-07-06T00:00:00Z"), "grant", "manual");

    const res = await adminRequest(app2).get(
      `/api/v2/credits-admin/accounts/${a}/ledger?kind=sub_grant`,
    );
    const body = res.body as LedgerResponse;
    expect(body.rows).toHaveLength(3);
    expect(new Set(body.rows.map((r) => r.delta))).toEqual(
      new Set(["1", "2", "3"]),
    );
  });

  it("400 on an unknown kind", async () => {
    const a = await seedAccount();
    t2.push(a);
    const res = await adminRequest(app2).get(
      `/api/v2/credits-admin/accounts/${a}/ledger?kind=bogus`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_request" });
  });

  it("400 on an unparseable date", async () => {
    const a = await seedAccount();
    t2.push(a);
    const res = await adminRequest(app2).get(
      `/api/v2/credits-admin/accounts/${a}/ledger?to=not-a-date`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_request" });
  });

  it("back-compat: no filter params returns the full page", async () => {
    const a = await seedAccount();
    t2.push(a);
    await addLedger(
      a,
      100n,
      new Date("2026-07-10T00:00:00Z"),
      "grant",
      "sub_grant",
    );
    await addLedger(
      a,
      500n,
      new Date("2026-07-12T00:00:00Z"),
      "grant",
      "manual",
    );
    const res = await adminRequest(app2).get(
      `/api/v2/credits-admin/accounts/${a}/ledger`,
    );
    expect(res.status).toBe(200);
    expect((res.body as LedgerResponse).rows).toHaveLength(2);
  });
});
