import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { agentRequest, buildCreditsApp, seedAccount } from "./helpers";

let app: Express;
beforeAll(() => { app = buildCreditsApp(); });

describe("POST /v2/accounts/:accountId/credits/grants", () => {
  it("happy path: 200 with replayed=false", async () => {
    const accountId = await seedAccount();
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/grants`, "g_1",
      { grantKind: "manual", creditsDelta: 50_000, reason: "test" },
    );
    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("false");
    expect(res.body.delta).toBe("50000");
    expect(res.body.balance).toBe("50000");
  });

  it("replay byte-identical", async () => {
    const accountId = await seedAccount();
    const body = { grantKind: "manual" as const, creditsDelta: 100, reason: "x" };
    const a = await agentRequest(app).post(`/v2/accounts/${accountId}/credits/grants`, "g_2", body);
    const b = await agentRequest(app).post(`/v2/accounts/${accountId}/credits/grants`, "g_2", body);
    expect(b.status).toBe(200);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.body).toEqual(a.body);
  });

  it("rejects invalid grantKind (B4)", async () => {
    const accountId = await seedAccount();
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/grants`, "g_3",
      { grantKind: "top_up_to_cap", creditsDelta: 100 },
    );
    expect(res.status).toBe(400);   // zod enum rejection
  });

  it("rejects creditsDelta > MAX_GRANT_CREDITS", async () => {
    const accountId = await seedAccount();
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/grants`, "g_4",
      { grantKind: "manual", creditsDelta: 1_000_000_001 },
    );
    expect(res.status).toBe(400);
  });

  it("404 for nonexistent account", async () => {
    const fakeId = "11111111-2222-3333-4444-555555555555";
    const res = await agentRequest(app).post(
      `/v2/accounts/${fakeId}/credits/grants`, "g_5",
      { grantKind: "manual", creditsDelta: 100 },
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("account_not_found");
  });
});
