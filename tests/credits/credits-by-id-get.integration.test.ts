import { randomUUID } from "node:crypto";
import { SubscriptionPeriod } from "@prisma/client";
import type { Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { consume } from "@/payments";
import { tierGrant } from "@/subscriptions/tier-config";
import { SUBSCRIPTION_TIER_PLUS } from "@/subscriptions/tiers";
import {
  agentRequest,
  buildCreditsApp,
  cleanupAccounts,
  clearAgentApiKeyOverride,
  installAgentApiKeyOverride,
  seedAccount,
  seedBalance,
  seedPlusMonthlySubscription,
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

describe("GET /v2/accounts/:accountId/credits", () => {
  it("returns balance + allowed for an account with credits", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
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
    tracker.push(accountId);
    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits`,
    );
    expect(res.status).toBe(200);
    expect((res.body as { balance: string }).balance).toBe("0");
  });

  it("returns 404 account_not_found for a UUID that does not match any Account", async () => {
    const fakeId = "11111111-2222-3333-4444-555555555555";
    const res = await agentRequest(app).get(`/v2/accounts/${fakeId}/credits`);
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe("account_not_found");
  });

  it("returns 400 invalid_account_id for non-UUID path param", async () => {
    const res = await agentRequest(app).get("/v2/accounts/not-a-uuid/credits");
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_account_id");
  });

  it("entitled subscriber → allowed; wallet holds the materialized period grant", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    // Single-ledger: subscribing writes a sub_grant of perPeriod into the wallet.
    await seedPlusMonthlySubscription(accountId);

    const perPeriod = tierGrant(
      SUBSCRIPTION_TIER_PLUS,
      SubscriptionPeriod.monthly,
    ).perPeriod;

    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accountId,
      balance: String(perPeriod),
      allowed: true,
    });
  });

  it("entitled subscriber whose wallet is drained → not allowed", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const perPeriod = tierGrant(
      SUBSCRIPTION_TIER_PLUS,
      SubscriptionPeriod.monthly,
    ).perPeriod;
    // Real decrement through the one wallet down to exactly the floor (0),
    // mirroring how a subscriber now spends in the single-ledger model.
    await consume({
      accountId,
      usdCostMicros: BigInt(perPeriod * 500),
      idempotencyKey: `c-${randomUUID()}`,
      requestId: "drain",
    });

    const res = await agentRequest(app).get(
      `/v2/accounts/${accountId}/credits`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accountId, balance: "0", allowed: false });
  });
});
