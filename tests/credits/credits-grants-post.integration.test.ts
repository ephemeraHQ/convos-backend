import type { Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

describe("POST /v2/accounts/:accountId/credits/grants", () => {
  it("happy path: 200 with replayed=false", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/grants`,
      "g_1",
      { grantKind: "manual", creditsDelta: 50_000, reason: "test" },
    );
    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("false");
    const body = res.body as { delta: string; balance: string };
    expect(body.delta).toBe("50000");
    expect(body.balance).toBe("50000");
  });

  it("replay byte-identical", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const body = {
      grantKind: "manual" as const,
      creditsDelta: 100,
      reason: "x",
    };
    const a = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/grants`,
      "g_2",
      body,
    );
    const b = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/grants`,
      "g_2",
      body,
    );
    expect(b.status).toBe(200);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.body).toEqual(a.body);
  });

  it("rejects invalid grantKind (B4)", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/grants`,
      "g_3",
      { grantKind: "top_up_to_cap", creditsDelta: 100 },
    );
    expect(res.status).toBe(400); // zod enum rejection
  });

  it("rejects creditsDelta > MAX_GRANT_CREDITS", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/grants`,
      "g_4",
      { grantKind: "manual", creditsDelta: 1_000_000_001 },
    );
    expect(res.status).toBe(400);
  });

  it("404 for nonexistent account", async () => {
    const fakeId = "11111111-2222-3333-4444-555555555555";
    const res = await agentRequest(app).post(
      `/v2/accounts/${fakeId}/credits/grants`,
      "g_5",
      { grantKind: "manual", creditsDelta: 100 },
    );
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe("account_not_found");
  });
});
