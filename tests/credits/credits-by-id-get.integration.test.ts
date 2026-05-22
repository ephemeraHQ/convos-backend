import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  agentRequest,
  buildCreditsApp,
  seedAccount,
  seedBalance,
} from "./helpers";

let app: Express;
beforeAll(() => {
  app = buildCreditsApp();
});

describe("GET /v2/accounts/:accountId/credits", () => {
  it("returns balance + allowed for an account with credits", async () => {
    const accountId = await seedAccount();
    await seedBalance(accountId, 12345n);

    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accountId,
      balance: "12345",
      allowed: true,
    });
  });

  it("returns balance='0' for an account with no UserCredits row", async () => {
    const accountId = await seedAccount();
    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits`,
    );
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe("0");
  });

  it("returns 404 account_not_found for a UUID that does not match any Account", async () => {
    const fakeId = "11111111-2222-3333-4444-555555555555";
    const res = await agentRequest(app).get(`/v2/accounts/${fakeId}/credits`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("account_not_found");
  });

  it("returns 400 invalid_account_id for non-UUID path param", async () => {
    const res = await agentRequest(app).get("/v2/accounts/not-a-uuid/credits");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_account_id");
  });
});
