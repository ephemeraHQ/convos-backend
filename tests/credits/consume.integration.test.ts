import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import {
  buildCreditsApp,
  cleanupAccounts,
  seedAccount,
  seedBalance,
  TEST_AGENT_API_KEY,
} from "./helpers";

const BASE = "http://localhost:4079";
let server: Server;
const tracker: string[] = [];

beforeAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(TEST_AGENT_API_KEY);
  const app = buildCreditsApp();
  await new Promise<void>((resolve) => {
    server = app.listen(4079, () => {
      resolve();
    });
  });
});

afterEach(async () => {
  await cleanupAccounts(tracker);
  tracker.length = 0;
});

afterAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(undefined);
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

const headers = (
  overrides: Record<string, string> = {},
): Record<string, string> => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": TEST_AGENT_API_KEY,
  ...overrides,
});

const post = (path: string, body: unknown, hdrs = headers()) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify(body),
  });

describe("POST /api/v2/credits/consume", () => {
  test("happy path → 200 spent + balance + replayed:false", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 1000n);

    const res = await post("/api/v2/credits/consume", {
      accountId,
      usdCostMicros: "100",
      idempotencyKey: "idem-happy-1",
      requestId: "req-happy-1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.replayed).toBe(false);
    expect(body.spent).toBe(1); // 100 micros × markup=2 × cpd=1000 / 10^10 = 0.2 → ceilDiv → 1 credit
    expect(typeof body.balance).toBe("string");
  });

  test("idempotent replay → 200 replayed:true with same spent", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 1000n);

    const body = {
      accountId,
      usdCostMicros: "100",
      idempotencyKey: "idem-replay-1",
      requestId: "req-replay-1",
    };
    const a = (await (
      await post("/api/v2/credits/consume", body)
    ).json()) as Record<string, unknown>;
    const b = (await (
      await post("/api/v2/credits/consume", body)
    ).json()) as Record<string, unknown>;
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.spent).toBe(a.spent);
    expect(b.balance).toBe(a.balance); // confirms no double-debit on replay
  });

  test("insufficient balance → 402 + code:insufficient_balance + JSON serializes", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    // Don't seed balance — account starts at 0n.

    const res = await post("/api/v2/credits/consume", {
      accountId,
      usdCostMicros: "10000000", // 10M micros = $10 → 20_000 credits with markup=2, cpd=1000
      idempotencyKey: "idem-broke-1",
      requestId: "req-broke-1",
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBeDefined();
    expect(body.details).toBeDefined();
    const details = body.details as Record<string, unknown>;
    expect(typeof details.currentBalance).toBe("string");
    expect(body.code).toBe("insufficient_balance");
  });

  test("unknown account → 409 + code:account_not_found", async () => {
    const accountId = randomUUID();
    const res = await post("/api/v2/credits/consume", {
      accountId,
      usdCostMicros: "100",
      idempotencyKey: "idem-ghost-1",
      requestId: "req-ghost-1",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("account_not_found");
  });

  test("idempotency mismatch → 409 + code:idempotency_mismatch", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 1000n);

    await post("/api/v2/credits/consume", {
      accountId,
      usdCostMicros: "100",
      idempotencyKey: "idem-conflict-1",
      requestId: "req-conflict-a",
    });
    const res = await post("/api/v2/credits/consume", {
      accountId,
      usdCostMicros: "200",
      idempotencyKey: "idem-conflict-1",
      requestId: "req-conflict-b",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("idempotency_mismatch");
  });

  test("usdCostMicros above 10^9 → 400", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await post("/api/v2/credits/consume", {
      accountId,
      usdCostMicros: "1000000001",
      idempotencyKey: "idem-overrange-1",
      requestId: "req-overrange-1",
    });
    expect(res.status).toBe(400);
  });

  test("missing X-Agent-API-Key → 401", async () => {
    const res = await post(
      "/api/v2/credits/consume",
      {
        accountId: randomUUID(),
        usdCostMicros: "100",
        idempotencyKey: "idem-noauth-1",
        requestId: "req-noauth-1",
      },
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(401);
  });
});
