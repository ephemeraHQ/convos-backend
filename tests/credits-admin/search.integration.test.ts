import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  adminRequest,
  buildCreditsAdminApp,
  cleanupAdminAccounts,
  seedAccount,
  seedSiweAuthMethod,
} from "./helpers";

describe("GET /api/v2/credits-admin/search", () => {
  let app: Express;
  const tracker: string[] = [];
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });
  afterEach(async () => {
    await cleanupAdminAccounts(tracker);
    tracker.length = 0;
  });

  it("resolves by accountId", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/search?key=accountId&value=${accountId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accountId });
  });

  it("resolves by wallet externalKey", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const wallet = `0xWALLET_${randomUUID()}`;
    await seedSiweAuthMethod(accountId, wallet);
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/search?key=wallet&value=${encodeURIComponent(wallet)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accountId });
  });

  it("clean miss → accountId null, 200", async () => {
    const res = await adminRequest(app).get(
      `/api/v2/credits-admin/search?key=accountId&value=${randomUUID()}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accountId: null });
  });

  it("non-uuid accountId value → null (treated as miss, not 500)", async () => {
    const res = await adminRequest(app).get(
      "/api/v2/credits-admin/search?key=accountId&value=not-a-uuid",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accountId: null });
  });

  it("invalid key → 400", async () => {
    const res = await adminRequest(app).get(
      "/api/v2/credits-admin/search?key=UNKNOWN&value=x",
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_request" });
  });

  it("missing admin token → 401", async () => {
    const res = await adminRequest(app, false).get(
      "/api/v2/credits-admin/search?key=accountId&value=x",
    );
    expect(res.status).toBe(401);
  });
});
