import { LedgerReason } from "@prisma/client";
import type { Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getBalance } from "@/payments";
import { prisma } from "@/utils/prisma";
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

describe("POST /v2/accounts/:accountId/credits/transactions", () => {
  it("happy path: returns 200 with Idempotent-Replayed: false header", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 100_000n);
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      "txn_1",
      { usdCostMicros: "12345", requestId: "llm_1" },
    );
    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("false");
    const body = res.body as {
      ledgerId: string;
      delta: string;
      balance: string;
    };
    expect(body.ledgerId).toBeDefined();
    expect(body.delta).toMatch(/^-?\d+$/);
    expect(body.balance).toMatch(/^\d+$/);
  });

  it("replay: same key + same body → 200 + Idempotent-Replayed: true + byte-identical body", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
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
    tracker.push(accountId);
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
    expect((res.body as { code: string }).code).toBe("idempotency_mismatch");
  });

  it("missing Idempotency-Key → 400 invalid_idempotency_key", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      "",
      { usdCostMicros: "100", requestId: "r" },
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_idempotency_key");
  });

  it.each([
    // newline / control chars / non-ASCII are rejected by Node's HTTP client
    // before reaching the route, so the schema unit tests cover those cases.
    ["whitespace", "abc def"],
    ["over-length", "a".repeat(256)],
  ])("rejects invalid Idempotency-Key (%s)", async (_label, key) => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      key,
      { usdCostMicros: "100", requestId: "r" },
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_idempotency_key");
  });

  it("insufficient balance → 402", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 10n); // below floor after giant consume
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      "txn_4",
      { usdCostMicros: "1000000000", requestId: "r" },
    );
    expect(res.status).toBe(402);
    expect((res.body as { code: string }).code).toBe("insufficient_balance");
  });

  it("404 for nonexistent account", async () => {
    const fakeId = "11111111-2222-3333-4444-555555555555";
    const res = await agentRequest(app).post(
      `/v2/accounts/${fakeId}/credits/transactions`,
      "txn_5",
      { usdCostMicros: "100", requestId: "r" },
    );
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe("account_not_found");
  });

  it("subscriber consume records usage without moving raw balance, never 402", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);

    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      `sub-${accountId}`,
      { usdCostMicros: "1000000", requestId: "req-sub" },
    );
    expect(res.status).toBe(200);
    // Raw balance untouched (record-only).
    expect(await getBalance(accountId)).toBe(0n);
    const row = await prisma.creditLedger.findFirst({
      where: { accountId, reason: LedgerReason.consume },
    });
    expect(row).not.toBeNull();
    expect(row?.delta).toBe(-2000n);
  });

  it("subscriber idempotency mismatch: same key + different body → 409", async () => {
    // Mirrors the non-subscriber 409 test above, but on the entitled-subscriber
    // consume-split replay path (reconstructReplay). A reused key with a
    // different usdCostMicros must surface idempotency_mismatch, not a silent
    // 200 replay.
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    const first = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      `sub-mismatch-${accountId}`,
      { usdCostMicros: "1000000", requestId: "req-sub" },
    );
    expect(first.status).toBe(200);
    const res = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      `sub-mismatch-${accountId}`,
      { usdCostMicros: "2000000", requestId: "req-sub" },
    );
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe("idempotency_mismatch");
  });

  it("subscriber replay returns the ORIGINAL balanceAfter snapshot, not a live read", async () => {
    // The replay must echo the original split's stored balanceAfter even if raw
    // drifts between the two calls. Seed raw so the consume overflows (writing a
    // raw leg with a balanceAfter snapshot), capture the first response, mutate
    // raw, then replay — the replayed body must equal the first, byte-identical.
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedPlusMonthlySubscription(accountId);
    await seedBalance(accountId, 5000n);
    // ~2900 credits: spills past the ~2500 derived allotment into raw, writing a
    // raw leg with a balanceAfter snapshot (well within the 5000 raw + floor).
    const body = { usdCostMicros: "1450000", requestId: "req-sub-replay" };
    const key = `sub-replay-${accountId}`;
    const first = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      key,
      body,
    );
    expect(first.status).toBe(200);
    // Drift raw between the two calls — a live getBalance() would now differ.
    await prisma.userCredits.update({
      where: { accountId },
      data: { balance: 999_999n },
    });
    const second = await agentRequest(app).post(
      `/v2/accounts/${accountId}/credits/transactions`,
      key,
      body,
    );
    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    // Original snapshot preserved despite the raw mutation.
    expect(second.body).toEqual(first.body);
    expect((second.body as { balance: string }).balance).not.toBe("999999");
  });

  // PR-A unique constraint is still (accountId, idempotencyKey). PR-B swaps it
  // to (accountId, scope, idempotencyKey) which is what makes /transactions vs
  // /grants share-a-key safe. Until then, same-key across routes hits a P2002.
  it.skip("cross-route: same key on /transactions and /grants is independent", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
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
    const txnBody = txn.body as { ledgerId: string };
    const grantBody = grant.body as { ledgerId: string };
    expect(txnBody.ledgerId).not.toEqual(grantBody.ledgerId);
  });
});
