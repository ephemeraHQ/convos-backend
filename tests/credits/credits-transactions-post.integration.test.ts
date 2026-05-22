import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  agentRequest,
  buildCreditsApp,
  seedAccount,
  seedBalance,
} from "./helpers";

// NOTE: These tests are intentionally RED until Tasks 12, 14, and 16 land:
//   - Task 12: POST /v2/accounts/:accountId/credits/grants handler (needed by
//              the cross-route test below).
//   - Task 14: accountsByIdRouter (mounts meGuard + both POST handlers).
//   - Task 16: v2/index.ts restructure (plugs accountsByIdRouter into the app).
//
// buildCreditsApp() currently mounts only the legacy /api/v2/credits router.
// All requests to /v2/accounts/:accountId/credits/* return 404 until Task 16.

let app: Express;
beforeAll(() => {
  app = buildCreditsApp();
});

describe("POST /v2/accounts/:accountId/credits/transactions", () => {
  it("happy path: returns 200 with Idempotent-Replayed: false header", async () => {
    const accountId = await seedAccount();
    await seedBalance(accountId, 100_000n);
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      "txn_1",
      { usdCostMicros: "12345", requestId: "llm_1" },
    );
    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("false");
    expect(res.body.ledgerId).toBeDefined();
    expect(res.body.delta).toMatch(/^-?\d+$/);
    expect(res.body.balance).toMatch(/^\d+$/);
  });

  it("replay: same key + same body → 200 + Idempotent-Replayed: true + byte-identical body", async () => {
    const accountId = await seedAccount();
    await seedBalance(accountId, 100_000n);
    const body = { usdCostMicros: "12345", requestId: "llm_2" };
    const first = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      "txn_2",
      body,
    );
    const second = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      "txn_2",
      body,
    );
    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
  });

  it("idempotency mismatch: same key + different body → 409", async () => {
    const accountId = await seedAccount();
    await seedBalance(accountId, 100_000n);
    await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      "txn_3",
      { usdCostMicros: "100", requestId: "r" },
    );
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      "txn_3",
      { usdCostMicros: "200", requestId: "r" },
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("idempotency_mismatch");
  });

  it("missing Idempotency-Key → 400 invalid_idempotency_key", async () => {
    const accountId = await seedAccount();
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      "",
      { usdCostMicros: "100", requestId: "r" },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_idempotency_key");
  });

  it.each([
    ["control-char", "abcdef"],
    ["newline", "abc\ndef"],
    ["whitespace", "abc def"],
    ["over-length", "a".repeat(256)],
  ])("rejects invalid Idempotency-Key (%s)", async (_label, key) => {
    const accountId = await seedAccount();
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      key,
      { usdCostMicros: "100", requestId: "r" },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_idempotency_key");
  });

  it("insufficient balance → 402", async () => {
    const accountId = await seedAccount();
    await seedBalance(accountId, 10n); // below floor after giant consume
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      "txn_4",
      { usdCostMicros: "1000000000", requestId: "r" },
    );
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("insufficient_balance");
  });

  it("404 for nonexistent account", async () => {
    const fakeId = "11111111-2222-3333-4444-555555555555";
    const res = await agentRequest(app).post(
      `/v2/accounts/${fakeId}/credits/transactions`,
      "txn_5",
      { usdCostMicros: "100", requestId: "r" },
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("account_not_found");
  });

  it("cross-route: same key on /transactions and /grants is independent", async () => {
    // NOTE: This test also requires the /grants handler (Task 12) to be wired.
    // It will remain RED until Tasks 12 + 14 + 16 all land.
    const accountId = await seedAccount();
    await seedBalance(accountId, 100_000n);
    const txn = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      "shared_key",
      { usdCostMicros: "100", requestId: "r" },
    );
    const grant = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/grants`,
      "shared_key",
      { grantKind: "manual", creditsDelta: 100, reason: "test" },
    );
    expect(txn.status).toBe(200);
    expect(grant.status).toBe(200);
    expect(txn.body.ledgerId).not.toEqual(grant.body.ledgerId);
  });
});
